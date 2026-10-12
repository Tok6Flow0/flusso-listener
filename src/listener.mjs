import { createHash } from 'node:crypto';
import { classifyEntry } from './model.mjs';

export function createListener({ store, cloud, buildRunRequest, classify = classifyEntry, clock = Date.now }) {
  let timer = null, busy = false, activeAbort = null;
  const state = { running: false, busy: false, lastCheckedAtUtc: null, lastError: null, cloudComplete: null, cloudReason: null };
  const keyOf = entry => `${entry.origin}:${entry.id}`;
  function inScope(entry, settings) {
    return (settings.source === 'both' || entry.origin === settings.source)
      && (!settings.notebookIds.length || settings.notebookIds.includes(entry.notebookId))
      && (!settings.section || entry.body.split('\n').some(line => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, '').trim().toLocaleLowerCase() === settings.section.toLocaleLowerCase()));
  }
  function checkpointExisting() {
    for (const entry of store.entries()) store.put('checkpoint', keyOf(entry), { version: entry.version, state: 'baseline', atUtc: new Date(clock()).toISOString() });
  }
  async function reconcileUnknown() {
    for (const attempt of store.all('attempt').filter(row => row.status === 'pending' || row.status === 'unknown')) {
      try {
        const receipt = await cloud.reconcileRunByKey(attempt);
        if (receipt && ['submitted', 'blocked'].includes(receipt.status)) store.put('attempt', attempt.id, { ...attempt, receipt, status: 'reconciled' });
        else { state.lastError = 'An execution outcome is unresolved. Execution is paused; inspect its original retry key in Activity.'; return false; }
      } catch { state.lastError = 'An execution outcome cannot be verified. Execution remains paused.'; return false; }
    }
    return true;
  }
  async function tick() {
    if (busy || !store.settings().enabled) return;
    busy = true; state.busy = true; activeAbort = new AbortController();
    try {
      let settings = store.settings(); state.lastError = null;
      if (settings.source !== 'local') {
        const snapshot = await cloud.readJournal({ notebookIds: settings.notebookIds });
        store.importCloud(snapshot);
        state.cloudComplete = snapshot.complete; state.cloudReason = snapshot.reason ?? null;
        // First connection/import is a baseline, not an instruction to trade old notes.
        if (!store.get('sync', 'baseline')) { checkpointExisting(); store.put('sync', 'baseline', { atUtc: new Date(clock()).toISOString() }); }
      }
      const reconciled = await reconcileUnknown();
      for (const entry of store.entries().filter(entry => inScope(entry, settings))) {
        if (!store.settings().enabled || activeAbort.signal.aborted) break;
        const key = keyOf(entry), checkpoint = store.get('checkpoint', key);
        if (checkpoint?.version === entry.version) continue;
        if (entry.status !== 'watching') { store.put('checkpoint', key, { version: entry.version, state: 'inactive' }); continue; }
        const settingsVersion = settings.version;
        const decision = await classify({ entry, instructions: settings.instructions, signal: activeAbort.signal });
        const latestSettings = store.settings();
        if (activeAbort.signal.aborted || latestSettings.version !== settingsVersion || !latestSettings.enabled || !inScope(entry, latestSettings)) break;
        const atUtc = new Date(clock()).toISOString();
        const activity = { id: createHash('sha256').update(`${key}:${entry.version}`).digest('hex'), entryId: entry.id, title: entry.title, origin: entry.origin, version: entry.version, decision: decision.decision, reason: decision.reason, atUtc, status: 'observed' };
        // Checkpoint before any possible dispatch. An interrupted/unknown dispatch is recovered by its durable attempt.
        store.put('activity', activity.id, activity); store.put('checkpoint', key, { version: entry.version, state: 'observed', atUtc });
        settings = store.settings();
        if (decision.decision !== 'candidate' || !settings.executionEnabled) continue;
        if (!reconciled || state.cloudComplete === false && entry.origin === 'cloud') { store.put('activity', activity.id, { ...activity, status: 'review', reason: 'Execution is paused until the cloud read and previous outcomes are verified.' }); continue; }
        const request = buildRunRequest({ entry, settings, now: clock() });
        if (!request.eligible) { store.put('activity', activity.id, { ...activity, status: 'review', reason: request.reason }); continue; }
        const currentSettings = store.settings();
        if (!currentSettings.enabled || !currentSettings.executionEnabled || currentSettings.version !== settingsVersion || activeAbort.signal.aborted) break;
        if (!request.signalIdentity) { store.put('activity', activity.id, { ...activity, status: 'review', reason: 'A stable source signal identity is required before execution.' }); continue; }
        const idempotencyKey = 'listener-' + createHash('sha256').update(`${settings.listenerId}:${settings.authorizationId}:${request.signalIdentity}`).digest('hex');
        const attempt = { id: idempotencyKey, signalIdentity: request.signalIdentity, idempotencyKey, accountId: settings.accountId, authorizationId: settings.authorizationId, body: request.body, entryId: entry.id, version: entry.version, status: 'pending', atUtc };
        if (!store.claimAttempt(attempt)) { store.put('activity', activity.id, { ...activity, status: 'review', reason: 'This source signal already has a durable execution attempt. Editing or copying a note does not submit it again.' }); continue; }
        try {
          const receipt = await cloud.runApprovedSignal(attempt);
          const unknown = !receipt || ['unknown', 'planned'].includes(receipt.status);
          store.put('attempt', attempt.id, { ...attempt, status: unknown ? 'unknown' : 'answered', receipt });
          store.put('activity', activity.id, { ...activity, status: unknown ? 'unknown' : 'answered', reason: unknown ? 'The submission outcome is unknown. Execution is paused pending canonical readback.' : 'Flusso returned a command receipt; this does not establish a fill.' });
          if (unknown) { state.lastError = 'Execution outcome unknown. No new submissions until it is reconciled.'; break; }
        } catch {
          store.put('attempt', attempt.id, { ...attempt, status: 'unknown' });
          state.lastError = 'Execution outcome unknown. No new submissions until it is reconciled.'; break;
        }
      }
      state.lastCheckedAtUtc = new Date(clock()).toISOString();
    } catch (error) { if (!activeAbort.signal.aborted) state.lastError = error?.message?.includes('local model') || error?.message?.includes('classification') ? error.message : 'The listener could not complete its check. No new execution was admitted.'; }
    finally { busy = false; state.busy = false; activeAbort = null; }
  }
  function schedule() {
    if (timer) clearTimeout(timer); timer = null;
    state.running = store.settings().enabled;
    if (state.running) timer = setTimeout(async () => { await tick(); schedule(); }, store.settings().intervalSeconds * 1000);
  }
  return {
    status: () => ({ ...state }), tick,
    start() { checkpointExisting(); schedule(); },
    refresh({ baseline = false } = {}) { activeAbort?.abort(); if (baseline) checkpointExisting(); schedule(); },
    stop() { if (timer) clearTimeout(timer); timer = null; activeAbort?.abort(); state.running = false; },
  };
}
