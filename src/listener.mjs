import { createHash, randomUUID } from 'node:crypto';
import { classifyEntry, modelInputCoverage } from './model.mjs';
import { buildOrderRequest, readTicket, withResult } from './orders.mjs';
import { entryInScope as inScope, ticketSetupGap } from './handoff.mjs';

const MAX_READBACK_CHECKS = 10;

export function summarize(receipt, count, kind = 'orders') {
  const placed = receipt.lines?.filter(line => line.status === 'submitted').length ?? 0;
  if (kind === 'close') {
    const noun = count === 1 ? 'position' : 'positions';
    switch (receipt.status) {
      case 'submitted': return `${count} ${noun} close${count === 1 ? '' : 's'} accepted by Flusso. Accepted is not settled until the venue fills.`;
      case 'partial': return `${placed} of ${count} closes accepted. Check remaining positions in Flusso.`;
      case 'blocked': return receipt.message || receipt.lines?.find(line => line.status === 'blocked')?.message || 'Flusso refused the closes.';
      default: return receipt.message || 'Close result unconfirmed. Check positions in Flusso; this ticket will not be resent.';
    }
  }
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
  // Research keeps its latest completed result per revision. A later unfinished
  // check uses a separate bounded row and cannot erase that accepted result.
  const completed = store.all('activity').filter(row => row.status === 'observed' && ['candidate', 'review', 'ignore'].includes(row.decision)
    && typeof row.reason === 'string' && Number.isFinite(Date.parse(row.completedAtUtc ?? row.atUtc)))
    .sort((a, b) => (b.completedAtUtc ?? b.atUtc).localeCompare(a.completedAtUtc ?? a.atUtc))[0];
  const restored = completed ? { ...completed, activityId: completed.id, startedAtUtc: completed.atUtc, atUtc: completed.completedAtUtc ?? completed.atUtc, completionKnown: Boolean(completed.completedAtUtc) } : null;
  const state = { running: false, busy: false, lastCheckedAtUtc: null, lastError: null, cloudComplete: null, cloudReason: null,
    processing: null, events: [], lastModelOutput: restored, modelOutput: null, modelReview: null, sequence: 0 };
  const subscribers = new Set();
  function changed() {
    state.sequence += 1;
    for (const subscriber of subscribers) { try { subscriber(structuredClone(state)); } catch { /* A disconnected view cannot interrupt a check. */ } }
  }
  let eventSequence = 0;
  // Operation events and the model's streamed public answer remain distinct.
  // The model runs with thinking disabled; no hidden reasoning is requested or stored.
  function publish(stage, message, entry = null, details = {}) {
    const atUtc = new Date(clock()).toISOString();
    const event = { id: `${atUtc}:${++eventSequence}`, atUtc, stage, message,
      ...(entry ? { entryId: entry.id, title: entry.title, origin: entry.origin } : {}), ...details };
    state.events.push(event); if (state.events.length > 100) state.events.shift();
    state.processing = { running: state.busy, startedAtUtc: state.processing?.startedAtUtc ?? atUtc,
      updatedAtUtc: atUtc, ...event };
    changed();
  }
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
    const count = attempt.kind === 'close' ? (attempt.positionIds?.length ?? 0) : (attempt.orders?.length ?? 0);
    const reason = summarize(receipt, count, attempt.kind === 'close' ? 'close' : 'orders');
    publish('result', reason, { id: attempt.entryId, title: attempt.title, origin: attempt.origin }, { status: receipt.status });
    if (activity) store.put('activity', activity.id, { ...activity, status: receipt.status, reason });
    if (receipt.status === 'unknown' || !attempt.origin) return;
    const noted = await noteResult(store.entry(attempt.entryId, attempt.origin), { status: receipt.status, reason, lines: receipt.lines ?? [] });
    if (!noted && activity) store.put('activity', activity.id, { ...store.get('activity', activity.id), reason: `${reason} The result could not be noted on the Journal entry.` });
  }
  // Unknown delivery is checked through canonical GETs only. Replaying a POST
  // could admit a previously unsent line, including while auto-trade is off.
  async function reconcileUnknown() {
    for (const attempt of store.all('attempt').filter(row => ['pending', 'unknown'].includes(row.status))) {
      publish('reconcile', 'Checking a retained unconfirmed result. This ticket will not be resent.', { id: attempt.entryId, title: attempt.title, origin: attempt.origin });
      if (activeAbort.signal.aborted) return false;
      if (attempt.kind === 'close') {
        state.lastError = 'A position close is still unconfirmed. Check positions in Flusso, then mark it resolved in Activity. It will never be resent.';
        return false;
      }
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
  function tick({ reviewLatest = false } = {}) {
    if (stopped || busy || !store.settings().enabled) return activeTick ?? Promise.resolve();
    activeTick = runTick({ reviewLatest }).finally(() => { activeTick = null; });
    return activeTick;
  }
  async function placeTicket({ entry, request, activity, settingsVersion, reconciled }) {
    const settings = store.settings();
    const hold = reason => { store.put('activity', activity.id, { ...activity, status: 'review', reason }); publish('result', reason, entry, { status: 'review' }); return 'continue'; };
    // A setup gap is not a decision about the ticket: it stays unactioned and is
    // decided once the gap closes, as long as it is still inside the action window.
    const wait = reason => { store.put('activity', activity.id, { ...activity, status: 'waiting', reason: `${reason} The ticket will be decided once this is fixed.` }); publish('waiting', reason, entry, { status: 'waiting' }); return 'retry'; };
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
    const recent = store.all('attempt').filter(row => ['orders', 'close'].includes(row.kind) && Date.parse(row.atUtc) > since).length;
    if (recent >= (settings.maxTicketsPerDay ?? 24)) return refuse(`Daily limit reached: ${recent} tickets in the last 24 hours.`);
    if (!reconciled || (state.cloudComplete === false && entry.origin === 'cloud')) return wait('Waiting for a previous result or a complete cloud read.');
    if (!settings.enabled || settings.version !== settingsVersion || activeAbort.signal.aborted) return pauseBeforeClaim();
    const idempotencyKey = 'listener-' + createHash('sha256').update(`${settings.listenerId}:${settings.accountId}:${request.signalIdentity}`).digest('hex');
    let connection;
    try { connection = await cloud.status(); }
    catch { return wait('Flusso connection status is temporarily unavailable. No order was sent.'); }
    if (!connection.connected || !connection.scopes.includes('mcp:write')) return wait('Connect Flusso with write access.');
    if (activeAbort.signal.aborted || store.settings().version !== settingsVersion) return pauseBeforeClaim();
    const reference = request.ticketId ? `ticket ${request.ticketId}` : `Journal entry ${entry.id}`;
    const canDispatch = async () => {
      const current = store.settings(), currentConnection = await cloud.status();
      const allowed = !activeAbort.signal.aborted && current.enabled && current.executionEnabled
        && current.version === settingsVersion && current.accountId === settings.accountId
        && currentConnection.connected && currentConnection.clientId === connection.clientId
        && (currentConnection.connectionId ?? null) === (connection.connectionId ?? null);
      if (allowed) publish('submit', 'Confirming the validated instruction through Flusso. Waiting for its receipt.', entry);
      return allowed;
    };
    if (request.kind === 'close') {
      const attempt = { id: idempotencyKey, kind: 'close', signalIdentity: request.signalIdentity, idempotencyKey, accountId: settings.accountId, clientId: connection.clientId, connectionId: connection.connectionId ?? null, positionIds: structuredClone(request.positionIds), orders: [], reference, ticketId: request.ticketId, entryId: entry.id, origin: entry.origin, title: entry.title, version: entry.version, status: 'pending', retries: 0, atUtc: activity.atUtc };
      if (!store.claimAttempt(attempt)) return refuse('This ticket was already placed. Editing or copying the entry does not place it again.');
      store.put('activity', activity.id, { ...activity, attemptId: attempt.id, status: 'sending', reason: `Closing ${attempt.positionIds.length} position${attempt.positionIds.length === 1 ? '' : 's'} through Flusso…` });
      let receipt;
      try { receipt = await cloud.closePositions(attempt, { canDispatch }); }
      catch { receipt = { status: 'unknown', lines: [], message: 'Flusso did not confirm the close. Check positions in Flusso; this ticket will not be resent.' }; }
      await settle(attempt, receipt);
      if (receipt.status === 'unknown') { store.put('attempt', attempt.id, { ...store.get('attempt', attempt.id), retries: 1 }); state.lastError = 'A close result is unconfirmed. New tickets wait until it resolves.'; return 'stop'; }
      return 'continue';
    }
    const attempt = { id: idempotencyKey, kind: 'orders', signalIdentity: request.signalIdentity, idempotencyKey, accountId: settings.accountId, clientId: connection.clientId, connectionId: connection.connectionId ?? null, orders: structuredClone(request.orders), reference, ticketId: request.ticketId, entryId: entry.id, origin: entry.origin, title: entry.title, version: entry.version, status: 'pending', retries: 0, atUtc: activity.atUtc };
    if (!store.claimAttempt(attempt)) return refuse('This ticket was already placed. Editing or copying the entry does not place it again.');
    store.put('activity', activity.id, { ...activity, attemptId: attempt.id, status: 'sending', reason: `Sending ${attempt.orders.length} order${attempt.orders.length === 1 ? '' : 's'} to Flusso…` });
    let receipt;
    try { receipt = await cloud.submitOrders(attempt, { canDispatch }); }
    catch { receipt = { status: 'unknown', lines: [], message: 'Flusso did not confirm the result. The listener will check canonical orders without resending this ticket.' }; }
    await settle(attempt, receipt);
    if (receipt.status === 'unknown') { store.put('attempt', attempt.id, { ...store.get('attempt', attempt.id), retries: 1 }); state.lastError = 'An order result is unconfirmed. New tickets wait until it resolves.'; return 'stop'; }
    return 'continue';
  }
  async function runTick({ reviewLatest }) {
    busy = true; state.busy = true; activeAbort = new AbortController();
    state.processing = null;
    const review = state.modelReview = { id: randomUUID(), startedAtUtc: new Date(clock()).toISOString(), status: 'checking', reason: null };
    publish('read', 'Starting a Listener check.');
    try {
      const settings = store.settings(); state.lastError = null;
      if (settings.source !== 'local') {
        publish('sync', 'Reading the selected cloud Journal notebooks.');
        const snapshot = await cloud.readJournal({ notebookIds: settings.notebookIds });
        if (activeAbort.signal.aborted || !store.settings().enabled || store.settings().version !== settings.version) return;
        store.importCloud(snapshot);
        state.cloudComplete = snapshot.complete; state.cloudReason = snapshot.reason ?? null;
        publish('sync', snapshot.complete ? `Read ${snapshot.entries.length} cloud entries; coverage is complete.` : (snapshot.reason || 'Cloud coverage is incomplete; cloud execution waits.'));
        // First connection/import is a baseline, not an instruction to trade old notes.
        if (!store.get('sync', 'baseline')) { checkpointExisting(); store.put('sync', 'baseline', { atUtc: new Date(clock()).toISOString() }); }
      }
      publish('reconcile', 'Checking retained submission receipts before new execution.');
      const reconciled = await reconcileUnknown();
      // Explicit tickets use the owner's hard filters and risk limits. Freeform
      // classification instructions apply to research, not ready order tickets.
      const entries = store.entries().filter(entry => inScope(entry, settings))
        .map(entry => ({ entry, ticket: readTicket(entry.body) !== null }))
        .sort((left, right) => Number(right.ticket) - Number(left.ticket));
      // Each requested research review revisits one existing note; it never replays a
      // checkpointed ticket or revisits a closed note.
      const researchEntry = reviewLatest ? entries.filter(({ entry, ticket }) => !ticket && ['watching', 'reviewed'].includes(entry.status))
        .sort((a, b) => (b.entry.updatedAtUtc ?? b.entry.createdAtUtc).localeCompare(a.entry.updatedAtUtc ?? a.entry.createdAtUtc))[0]?.entry : null;
      const shouldReview = entry => entry.id === researchEntry?.id && entry.origin === researchEntry?.origin;
      const queued = entries.filter(({ entry }) => shouldReview(entry) || (entry.status === 'watching' && store.get('checkpoint', keyOf(entry))?.version !== entry.version));
      const total = queued.length; let index = 0, researchSkip = null;
      publish('queued', `${entries.length} selected entries; ${total} revision${total === 1 ? '' : 's'} to process${researchEntry ? "; includes latest research review" : ""}.`, null, { index, total });
      for (const { entry, ticket } of entries) {
        if (!store.settings().enabled || activeAbort.signal.aborted) break;
        const key = keyOf(entry), checkpoint = store.get('checkpoint', key);
        if (checkpoint?.version === entry.version && !shouldReview(entry)) continue;
        if (entry.status !== 'watching' && !shouldReview(entry)) { store.put('checkpoint', key, { version: entry.version, state: 'inactive' }); continue; }
        index += 1;
        publish('read', ticket ? 'Reading the explicit action ticket.' : 'Reading the note for a published model decision.', entry, { index, total });
        const settingsVersion = settings.version;
        const atUtc = new Date(clock()).toISOString();
        const resultId = createHash('sha256').update(`${key}:${entry.version}`).digest('hex');
        const activity = { id: ticket ? resultId : `${resultId}:research-check`, entryId: entry.id, title: entry.title, origin: entry.origin, version: entry.version, atUtc,
          ...(!ticket ? { kind: 'research_check', checkId: review.id } : {}) };
        if (ticket) {
          publish('validate', 'Validating ticket format, freshness and local limits. Explicit tickets use the execution path directly.', entry, { index, total });
          const request = buildRequest({ entry, settings: store.settings(), now: clock() });
          // Checkpoint before any dispatch. An interrupted dispatch is recovered by its durable attempt.
          store.put('activity', activity.id, { ...activity, decision: 'ticket', status: 'observed', reason: 'Action ticket found.' });
          store.put('checkpoint', key, { version: entry.version, state: 'observed', atUtc });
          const outcome = await placeTicket({ entry, request, activity: { ...activity, decision: 'ticket' }, settingsVersion, reconciled });
          if (outcome === 'retry' || outcome === 'retry-stop') store.delete('checkpoint', key); // No attempt was claimed: read it again next check.
          if (outcome === 'stop' || outcome === 'retry-stop') {
            researchSkip = outcome === 'retry-stop' ? 'Research review was skipped because Listener settings changed before dispatch.' : 'Research review was skipped while a ticket result requires attention.';
            break;
          }
          continue;
        }
        let decision;
        store.put('activity', activity.id, { ...activity, status: 'processing', reason: 'The local model is reading this note.' });
        publish('model', 'The local model is reading the note and preparing its response.', entry, { index, total });
        review.status = 'running'; review.reason = null;
        const coverage = modelInputCoverage(entry);
        state.modelOutput = { entryId: entry.id, title: entry.title, origin: entry.origin, version: entry.version, activityId: activity.id, checkId: review.id, coverage, atUtc, text: '', status: 'streaming' };
        changed();
        try {
          decision = await classify({ entry, instructions: settings.instructions, signal: activeAbort.signal, onOutput: delta => {
            if (activeAbort.signal.aborted) return;
            state.modelOutput.text += delta;
            if (Buffer.byteLength(state.modelOutput.text) > 32768) throw new Error('The local model response was too large.');
            changed();
          } });
        }
        catch (error) {
          state.modelOutput.status = review.status = activeAbort.signal.aborted ? 'stopped' : 'failed'; changed();
          if (activeAbort.signal.aborted) { store.put('activity', activity.id, { ...activity, status: 'waiting', reason: 'Model review paused before a decision. This note will be checked again when selected and the Listener is on.' }); break; }
          // Left unchecked so it is read again once the model is available.
          state.lastError = error?.message?.includes('local model') || error?.message?.includes('classification') ? error.message : 'The local model could not read a note.';
          store.put('activity', activity.id, { ...activity, status: 'waiting', reason: state.lastError });
          publish('error', state.lastError, entry, { index, total });
          continue;
        }
        const latestSettings = store.settings();
        if (activeAbort.signal.aborted || latestSettings.version !== settingsVersion || !latestSettings.enabled || !inScope(entry, latestSettings)) {
          state.modelOutput.status = review.status = 'stopped'; changed();
          store.put('activity', activity.id, { ...activity, status: 'waiting', reason: 'Listener settings changed before the model decision was accepted. This note will be checked again when selected and the Listener is on.' });
          break;
        }
        const completedAtUtc = new Date(clock()).toISOString();
        const accepted = { ...activity, id: resultId, kind: 'research', decision: decision.decision, reason: decision.reason, status: 'observed', completedAtUtc, coverage };
        store.put('activity', resultId, accepted);
        state.modelOutput.status = 'complete';
        review.status = 'complete';
        state.lastModelOutput = { ...accepted, activityId: resultId, startedAtUtc: atUtc, atUtc: completedAtUtc, completionKnown: true };
        // Only this exact check's successfully stored result supersedes progress.
        store.delete('activity', activity.id);
        publish('decision', decision.reason || `Model decision: ${decision.decision}.`, entry, { decision: decision.decision, index, total });
        publish('result', 'Research review complete. No order was requested for this note.', entry, { status: 'observed', index, total });
        store.put('checkpoint', key, { version: entry.version, state: 'observed', atUtc });
      }
      if (review.status === 'checking') {
        review.status = activeAbort.signal.aborted ? 'stopped' : state.lastError || researchSkip ? 'skipped' : 'not_run';
        review.reason = activeAbort.signal.aborted ? 'Research review was skipped because this check was paused.'
          : researchSkip ?? (state.lastError ? `Research review was skipped: ${state.lastError}`
            : reviewLatest && !researchEntry ? 'No eligible research note is available for this check. No model was run.' : 'No research revision required model review in this check.');
        publish('waiting', review.reason);
      }
      state.lastCheckedAtUtc = new Date(clock()).toISOString();
    } catch {
      const unfinished = state.modelOutput?.checkId === review.id && state.modelOutput.status === 'streaming';
      if (unfinished) state.modelOutput.status = activeAbort.signal.aborted ? 'stopped' : 'failed';
      review.status = activeAbort.signal.aborted ? 'stopped' : 'failed';
      if (!activeAbort.signal.aborted) {
        state.lastError = 'The listener could not finish its check. Inspect retained receipts for any instruction already dispatched.';
        if (unfinished) {
          try {
            const progress = store.get('activity', state.modelOutput.activityId);
            if (progress?.checkId === review.id) store.put('activity', progress.id, { ...progress, status: 'waiting', reason: state.lastError });
          } catch { /* A failed store cannot promise a durable error row; live state remains terminal. */ }
        }
        publish('error', state.lastError);
      }
    }
    finally {
      busy = false; state.busy = false;
      if (activeAbort.signal.aborted) {
        if (review.status === 'checking') review.reason = 'Research review was skipped because this check was paused.';
        review.status = 'stopped';
      }
      else if (state.lastError && review.status === 'checking') review.status = 'failed';
      review.completedAtUtc = new Date(clock()).toISOString();
      publish(activeAbort.signal.aborted ? 'paused' : 'idle', activeAbort.signal.aborted ? 'Check paused after a settings change or shutdown. Retained attempts keep their original delivery state.' : (state.lastError || 'Check complete. Waiting for the next scheduled check.'));
      activeAbort = null;
    }
  }
  function schedule() {
    const generation = ++scheduleGeneration;
    if (timer) clearTimeout(timer); timer = null;
    state.running = !stopped && store.settings().enabled;
    if (state.running) timer = setTimeout(async () => {
      if (stopped || generation !== scheduleGeneration) return;
      timer = null;
      await tick({ reviewLatest: true });
      if (!stopped && generation === scheduleGeneration) schedule();
    }, store.settings().intervalSeconds * 1000);
  }
  return {
    status: () => structuredClone(state), tick,
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
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
