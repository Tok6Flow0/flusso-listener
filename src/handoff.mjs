import { buildOrderRequest, readTicket } from './orders.mjs';

// Keep the status explanation and the Listener's hard selection on one predicate.
export function scopeMismatch(entry, settings) {
  if (settings.source !== 'both' && entry.origin !== settings.source) return 'source';
  if (settings.notebookIds.length && !settings.notebookIds.includes(entry.notebookId)) return 'notebook';
  if (settings.section && !entry.body.split('\n').some(line => /^#{1,6}\s/.test(line)
    && line.replace(/^#{1,6}\s+/, '').trim().toLocaleLowerCase() === settings.section.toLocaleLowerCase())) return 'section';
  return null;
}

export const entryInScope = (entry, settings) => scopeMismatch(entry, settings) === null;

export function ticketSetupGap(settings) {
  if (!settings.executionEnabled) return 'Auto-trade is off.';
  if (!settings.accountId) return 'Choose a trading account for auto-trade.';
  if (!settings.notebookIds.length) return 'Pick the notebooks auto-trade may act on.';
  return null;
}

/** Read-only explanation of local hand-off state, never a server or venue admission. */
export function describeEntryHandoff({ entry, settings, checkpoint = null, activity = null, attempts = [], now = Date.now(), ticket = readTicket(entry.body) }) {
  const kind = ticket === null ? 'research' : 'ticket';
  const mismatch = scopeMismatch(entry, settings);
  const currentCheckpoint = checkpoint?.version === entry.version ? checkpoint : null;
  const currentActivity = activity?.version === entry.version ? activity : null;
  const context = { inScope: mismatch === null, scopeMismatch: mismatch, entryStatus: entry.status, listenerEnabled: settings.enabled, checkpointState: currentCheckpoint?.state ?? null };
  const result = (code, reason) => ({ schemaVersion: 'flusso.listener_handoff.v1', kind, code, reason, context });
  const currentAttempts = attempts.filter(row => row.entryId === entry.id && row.origin === entry.origin && row.version === entry.version && ['orders', 'close', 'legacy'].includes(row.kind));
  // Delivery evidence outlives admission freshness, selection, and local opt-out.
  // Prefer uncertainty if inconsistent retained rows ever share the same revision.
  const attempt = currentAttempts.find(row => ['pending', 'unknown'].includes(row.status))
    ?? currentAttempts.find(row => ['partial', 'submitted'].includes(row.status)) ?? currentAttempts[0];
  const deliveryStatus = attempt?.status ?? (['sending', 'pending', 'unknown', 'submitted', 'partial', 'blocked', 'resolved'].includes(currentActivity?.status) ? currentActivity.status : null);
  if (deliveryStatus) {
    if (['pending', 'unknown'].includes(deliveryStatus)) return result('unconfirmed', 'A retained submission attempt for this revision is unconfirmed and may have been sent. Inspect its receipt; this ticket will not be resent.');
    if (deliveryStatus === 'sending') return result('sending', 'Submission for this revision is in progress or unconfirmed. It must not be treated as unsent.');
    if (deliveryStatus === 'submitted') return result('submitted', 'Submission for this revision was confirmed. Sent is not filled; inspect the retained receipt.');
    if (deliveryStatus === 'partial') return result('partial', 'This revision was partly submitted. Inspect every retained leg; residual exposure may remain.');
    if (deliveryStatus === 'blocked') return result('blocked', 'The retained attempt for this revision was refused. Inspect its receipt; its durable claim remains.');
    if (deliveryStatus === 'resolved') return result('resolved', 'The owner marked the unconfirmed attempt for this revision resolved. Its durable claim remains; it will not be resent.');
    return result('unconfirmed', 'A retained submission attempt exists for this revision. Inspect its original receipt before treating it as unsent; its durable claim remains.');
  }
  if (mismatch) return result('out_of_scope', {
    source: 'This entry is outside the selected local/cloud source.',
    notebook: 'This entry is outside the selected notebooks.',
    section: 'This entry does not contain the selected Markdown heading.',
  }[mismatch]);
  const research = 'No explicit flusso-orders or flusso-close ticket is present. Research and model classifications do not authorize submission.';
  if (entry.status !== 'watching') return result(entry.status, kind === 'research' && entry.status === 'reviewed'
    ? `Reviewed research can be reviewed again when it is the newest selected note and the Listener is on. ${research}`
    : `This entry is ${entry.status}; only watching entries can supply an action ticket.${kind === 'research' ? ` ${research}` : ''}`);
  if (currentCheckpoint?.state === 'baseline') return result('baselined', kind === 'research'
    ? `This existing revision was baselined. The newest selected research note is still reviewed each period while the Listener is on. ${research}`
    : 'This existing revision was baselined and will be skipped.');
  if (!settings.enabled) return result('listener_off', 'The Listener is off; no entry is checked or submitted.');
  if (ticket === null) return result('research_only', research);
  if (ticket.error) return result('malformed_ticket', ticket.error);
  const request = buildOrderRequest({ entry, settings, now });
  if (!request.eligible) return result(request.reasonCode, request.reason);
  if (currentActivity) {
    const code = currentActivity.status === 'waiting' ? 'waiting' : null;
    if (code || currentCheckpoint) return result(code ?? 'decided', currentActivity.reason || 'This ticket revision has already been observed; inspect its retained result.');
  }
  if (currentCheckpoint) return result('decided', 'This ticket revision has already been observed; inspect its retained result.');
  const gap = ticketSetupGap(settings);
  if (gap) return result('waiting', `${gap} No order has been sent for this revision.`);
  return result('awaiting_check', 'The explicit ticket passes local format, age and limit checks. A Listener check and current server admission are still required; this diagnostic sends nothing.');
}
