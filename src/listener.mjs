import { createHash } from 'node:crypto';
import { classifyEntry } from './model.mjs';
import { buildOrderRequest, readTicket, withResult } from './orders.mjs';
import { entryInScope as inScope, ticketSetupGap } from './handoff.mjs';

const MAX_READBACK_CHECKS = 10;

export function summarize(receipt, count) {
  const placed = receipt.lines?.filter(line => line.status === 'submitted').length ?? 0;
  const noun = count === 1 ? 'order' : 'orders';
  switch (receipt.status) {
    case 'submitted': return `${count} ${noun} sent to Flusso. Sent is not filled.`;
    case 'partial': return `${placed} of ${count} orders sent. Check the open leg in Flusso.`;
    case 'blocked': return receipt.message || receipt.lines?.find(line => line.status === 'blocked')?.message || 'Flusso refused the orders.';
    default: return receipt.message || 'Result unconfirmed. The listener will check canonical orders without resending this ticket.';
  }
}

export function createListener({ store, cloud, buildRequest = buildOrderRequest, classify = classifyEntry, clock = Date.now }) {
  let timer = null, busy = false, activeAbort = null, activeTick = null, stopped = false, scheduleGeneration = 0;
  const state = { running: false, busy: false, lastCheckedAtUtc: null, lastError: null, cloudComplete: null, cloudReason: null };
  const keyOf = entry => `${entry.origin}:${entry.id}`;
  // Old notes become a baseline, but an unactioned ticket from the action window is
  // still decided, even if it arrived while the app was closed or disconnected.
  function inWindow(entry) {
    const windowMs = (store.settings().maxSignalAgeSeconds ?? 21600) * 1000;
    const written = Date.parse(entry.updatedAtUtc ?? entry.createdAtUtc);
    return entry.status === 'watching' && readTicket(entry.body) !== null && Number.isFinite(written) && clock() - written <= windowMs;
  }
  function checkpointExisting() {
    for (const entry of store.entries()) {
      if (inWindow(entry)) {
        if (store.get('checkpoint', keyOf(entry))?.state === 'baseline') store.delete('checkpoint', keyOf(entry));
        continue;
      }
      store.put('checkpoint', keyOf(entry), { version: entry.version, state: 'baseline', atUtc: new Date(clock()).toISOString() });
    }
  }
  // Notes a final decision on the ticket's own entry and marks it reviewed. The new
  // revision is checkpointed so writing the result never triggers another decision.
  async function noteResult(entry, outcome) {
    if (!entry || store.settings().writeBack === false) return true;
    const current = store.entry(entry.id, entry.origin) ?? entry;
    const body = withResult(current.body, { ...outcome, atUtc: outcome.atUtc ?? new Date(clock()).toISOString() });
    if (body === null) return false;
    try {
      let updated;
      if (current.origin === 'local') {
        updated = { ...store.updateEntry(current.id, { notebookId: current.notebookId, title: current.title, body, instrument: current.instrument ?? null, venue: current.venue ?? null, status: 'reviewed', source: current.source ?? 'manual', observedAtUtc: current.observedAtUtc ?? null, version: current.version }), origin: 'local' };
      } else {
        const idempotencyKey = 'listener-note-' + createHash('sha256').update(`${current.id}:${current.version}:${outcome.status}`).digest('hex').slice(0, 48);
        updated = { ...await cloud.updateJournalEntry({ entry: current, body, status: 'reviewed', idempotencyKey }), origin: 'cloud' };
        store.importCloud({ notebooks: [], entries: [updated] });
      }
      store.put('checkpoint', keyOf(updated), { version: updated.version, state: 'result', atUtc: new Date(clock()).toISOString() });
      return true;
    } catch { return false; }
  }
  async function settle(attempt, receipt) {
    store.put('attempt', attempt.id, { ...attempt, status: receipt.status, receipt });
    const activity = store.all('activity').find(row => row.attemptId === attempt.id);
    const reason = summarize(receipt, attempt.orders.length);
    if (activity) store.put('activity', activity.id, { ...activity, status: receipt.status, reason });
    if (receipt.status === 'unknown' || !attempt.origin) return;
    const noted = await noteResult(store.entry(attempt.entryId, attempt.origin), { status: receipt.status, reason, lines: receipt.lines ?? [] });
    if (!noted && activity) store.put('activity', activity.id, { ...store.get('activity', activity.id), reason: `${reason} The result could not be noted on the Journal entry.` });
  }
  // Unknown delivery is checked through canonical GETs only. Replaying a POST
  // could admit a previously unsent line, including while auto-trade is off.
  async function reconcileUnknown() {
    for (const attempt of store.all('attempt').filter(row => ['pending', 'unknown'].includes(row.status))) {
      if (activeAbort.signal.aborted) return false;
      if (attempt.kind !== 'orders') { state.lastError = 'An earlier listener submission is unconfirmed. Check it in Flusso, then mark it resolved in Activity. It will never be resent.'; return false; }
      if ((attempt.retries ?? 0) >= MAX_READBACK_CHECKS) { state.lastError = 'An order result is still unconfirmed. Check it in Flusso, then mark it resolved in Activity.'; return false; }
      const connection = await cloud.status();
      if (!connection.connected || attempt.clientId !== connection.clientId || attempt.connectionId !== (connection.connectionId ?? null)
        || attempt.accountId !== store.settings().accountId) { state.lastError = 'An order result belongs to an earlier account or connection. Check it in Flusso; it will not be resent.'; return false; }
      let receipt = null;
      try { receipt = await cloud.reconcileOrders?.(attempt); } catch { receipt = null; }
      if (receipt && receipt.status !== 'unknown') { await settle(attempt, receipt); continue; }
      store.put('attempt', attempt.id, { ...attempt, status: 'unknown', retries: (attempt.retries ?? 0) + 1, receipt: receipt ?? attempt.receipt ?? null });
      state.lastError = 'An order result is still unconfirmed. Read-only checks continue; no ticket is resent.';
      return false;
    }
    return true;
  }
  function tick() {
    if (stopped || busy || !store.settings().enabled) return activeTick ?? Promise.resolve();
    activeTick = runTick().finally(() => { activeTick = null; });
    return activeTick;
  }
  async function placeTicket({ entry, request, activity, settingsVersion, reconciled }) {
    const settings = store.settings();
    const hold = reason => { store.put('activity', activity.id, { ...activity, status: 'review', reason }); return 'continue'; };
    // A setup gap is not a decision about the ticket: it stays unactioned and is
    // decided once the gap closes, as long as it is still inside the action window.
    const wait = reason => { store.put('activity', activity.id, { ...activity, status: 'waiting', reason: `${reason} The ticket will be decided once this is fixed.` }); return 'retry'; };
    const pauseBeforeClaim = () => {
      wait('Listener settings changed before dispatch. No order was sent.');
      return 'retry-stop';
    };
    const refuse = async reason => {
      hold(reason);
      if (!await noteResult(entry, { status: 'review', reason })) store.put('activity', activity.id, { ...activity, status: 'review', reason: `${reason} The result could not be noted on the Journal entry.` });
      return 'continue';
    };
    if (!request.eligible) return refuse(request.reason);
    const setupGap = ticketSetupGap(settings);
    if (setupGap) return wait(setupGap);
    // A flood of tickets, from a mistake or a hostile note, stops at the owner's daily cap.
    const since = clock() - 86400000;
    const recent = store.all('attempt').filter(row => row.kind === 'orders' && Date.parse(row.atUtc) > since).length;
    if (recent >= (settings.maxTicketsPerDay ?? 24)) return refuse(`Daily limit reached: ${recent} tickets in the last 24 hours.`);
    if (!reconciled || (state.cloudComplete === false && entry.origin === 'cloud')) { store.put('activity', activity.id, { ...activity, status: 'waiting', reason: 'Waiting for a previous result or a complete cloud read. It will be tried again.' }); return 'retry'; }
    if (!settings.enabled || settings.version !== settingsVersion || activeAbort.signal.aborted) return pauseBeforeClaim();
    const idempotencyKey = 'listener-' + createHash('sha256').update(`${settings.listenerId}:${settings.accountId}:${request.signalIdentity}`).digest('hex');
    let connection;
    try { connection = await cloud.status(); }
    catch { return wait('Flusso connection status is temporarily unavailable. No order was sent.'); }
    if (!connection.connected || !connection.scopes.includes('mcp:write')) return wait('Connect Flusso with write access.');
    if (activeAbort.signal.aborted || store.settings().version !== settingsVersion) return pauseBeforeClaim();
    const reference = request.ticketId ? `ticket ${request.ticketId}` : `Journal entry ${entry.id}`;
    const attempt = { id: idempotencyKey, kind: 'orders', signalIdentity: request.signalIdentity, idempotencyKey, accountId: settings.accountId, clientId: connection.clientId, connectionId: connection.connectionId ?? null, orders: structuredClone(request.orders), reference, ticketId: request.ticketId, entryId: entry.id, origin: entry.origin, title: entry.title, version: entry.version, status: 'pending', retries: 0, atUtc: activity.atUtc };
    if (!store.claimAttempt(attempt)) return refuse('This ticket was already placed. Editing or copying the entry does not place it again.');
    store.put('activity', activity.id, { ...activity, attemptId: attempt.id, status: 'sending', reason: `Sending ${attempt.orders.length} order${attempt.orders.length === 1 ? '' : 's'} to Flusso…` });
    let receipt;
    try { receipt = await cloud.submitOrders(attempt, { canDispatch: async () => {
      const current = store.settings(), currentConnection = await cloud.status();
      return !activeAbort.signal.aborted && current.enabled && current.executionEnabled
        && current.version === settingsVersion && current.accountId === attempt.accountId
        && currentConnection.connected && currentConnection.clientId === attempt.clientId
        && (currentConnection.connectionId ?? null) === attempt.connectionId;
    } }); }
    catch { receipt = { status: 'unknown', lines: [], message: 'Flusso did not confirm the result. The listener will check canonical orders without resending this ticket.' }; }
    await settle(attempt, receipt);
    if (receipt.status === 'unknown') { store.put('attempt', attempt.id, { ...store.get('attempt', attempt.id), retries: 1 }); state.lastError = 'An order result is unconfirmed. New tickets wait until it resolves.'; return 'stop'; }
    return 'continue';
  }
  async function runTick() {
    busy = true; state.busy = true; activeAbort = new AbortController();
    try {
      const settings = store.settings(); state.lastError = null;
      if (settings.source !== 'local') {
        const snapshot = await cloud.readJournal({ notebookIds: settings.notebookIds });
        if (activeAbort.signal.aborted || !store.settings().enabled || store.settings().version !== settings.version) return;
        store.importCloud(snapshot);
        state.cloudComplete = snapshot.complete; state.cloudReason = snapshot.reason ?? null;
        // First connection/import is a baseline, not an instruction to trade old notes.
        if (!store.get('sync', 'baseline')) { checkpointExisting(); store.put('sync', 'baseline', { atUtc: new Date(clock()).toISOString() }); }
      }
      const reconciled = await reconcileUnknown();
      // Explicit tickets use the owner's hard filters and risk limits. Freeform
      // classification instructions apply to research, not ready order tickets.
      const entries = store.entries().filter(entry => inScope(entry, settings))
        .map(entry => ({ entry, ticket: readTicket(entry.body) !== null }))
        .sort((left, right) => Number(right.ticket) - Number(left.ticket));
      for (const { entry, ticket } of entries) {
        if (!store.settings().enabled || activeAbort.signal.aborted) break;
        const key = keyOf(entry), checkpoint = store.get('checkpoint', key);
        if (checkpoint?.version === entry.version) continue;
        if (entry.status !== 'watching') { store.put('checkpoint', key, { version: entry.version, state: 'inactive' }); continue; }
        const settingsVersion = settings.version;
        const atUtc = new Date(clock()).toISOString();
        const activity = { id: createHash('sha256').update(`${key}:${entry.version}`).digest('hex'), entryId: entry.id, title: entry.title, origin: entry.origin, version: entry.version, atUtc };
        if (ticket) {
          const request = buildRequest({ entry, settings: store.settings(), now: clock() });
          // Checkpoint before any dispatch. An interrupted dispatch is recovered by its durable attempt.
          store.put('activity', activity.id, { ...activity, decision: 'ticket', status: 'observed', reason: 'Order ticket found.' });
          store.put('checkpoint', key, { version: entry.version, state: 'observed', atUtc });
          const outcome = await placeTicket({ entry, request, activity: { ...activity, decision: 'ticket' }, settingsVersion, reconciled });
          if (outcome === 'retry' || outcome === 'retry-stop') store.delete('checkpoint', key); // No attempt was claimed: read it again next check.
          if (outcome === 'stop' || outcome === 'retry-stop') break;
          continue;
        }
        let decision;
        try { decision = await classify({ entry, instructions: settings.instructions, signal: activeAbort.signal }); }
        catch (error) {
          if (activeAbort.signal.aborted) break;
          // Left unchecked so it is read again once the model is available.
          state.lastError = error?.message?.includes('local model') || error?.message?.includes('classification') ? error.message : 'The local model could not read a note.';
          continue;
        }
        const latestSettings = store.settings();
        if (activeAbort.signal.aborted || latestSettings.version !== settingsVersion || !latestSettings.enabled || !inScope(entry, latestSettings)) break;
        store.put('activity', activity.id, { ...activity, decision: decision.decision, reason: decision.reason, status: 'observed' });
        store.put('checkpoint', key, { version: entry.version, state: 'observed', atUtc });
      }
      state.lastCheckedAtUtc = new Date(clock()).toISOString();
    } catch { if (!activeAbort.signal.aborted) state.lastError = 'The listener could not finish its check. No new orders were sent.'; }
    finally { busy = false; state.busy = false; activeAbort = null; }
  }
  function schedule() {
    const generation = ++scheduleGeneration;
    if (timer) clearTimeout(timer); timer = null;
    state.running = !stopped && store.settings().enabled;
    if (state.running) timer = setTimeout(async () => {
      if (stopped || generation !== scheduleGeneration) return;
      timer = null;
      await tick();
      if (!stopped && generation === scheduleGeneration) schedule();
    }, store.settings().intervalSeconds * 1000);
  }
  return {
    status: () => ({ ...state }), tick,
    start() { stopped = false; checkpointExisting(); schedule(); },
    refresh({ baseline = false } = {}) { if (stopped) return; activeAbort?.abort(); if (baseline) checkpointExisting(); schedule(); },
    stop() {
      stopped = true; scheduleGeneration += 1;
      if (timer) clearTimeout(timer); timer = null;
      activeAbort?.abort(); state.running = false;
      // An already dispatched ticket must durably save its result or uncertainty
      // before shutdown closes SQLite. Aborting does not retry or cancel an order.
      return activeTick ?? Promise.resolve();
    },
  };
}
