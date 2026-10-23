import { formatCount } from './format.mjs';
// Presentation only: identity and native capabilities remain owned by the backend.
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function progress(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null; }

export function accountPresentation(cloud) {
  if (!cloud?.connected) return { name: 'Local workspace', detail: 'On this computer', initial: 'F', connected: false };
  const name = text(cloud.profile?.displayName);
  return { name: name || 'Connected account', detail: text(cloud.profile?.email) || 'Flusso connected', initial: name ? Array.from(name)[0].toLocaleUpperCase() : 'F', connected: true };
}

export function updatePresentation(update = {}) {
  const common = { state: update.state, version: text(update.version), percent: progress(update.percent), message: text(update.message), visible: false, action: null, label: 'Check for updates', busy: false };
  switch (update.state) {
    case 'checking': return { ...common, visible: true, label: 'Checking for updates…', busy: true };
    case 'available': return { ...common, visible: true, action: 'downloadUpdate', label: 'Download update' };
    case 'downloading': return { ...common, visible: true, label: 'Downloading update…', busy: true };
    case 'downloaded': return { ...common, visible: true, action: 'installUpdate', label: 'Restart to update' };
    case 'current': return { ...common, label: 'You’re up to date' };
    case 'error': return { ...common, visible: true, action: 'checkUpdates', label: 'Check again' };
    case 'unsupported': return { ...common, label: 'Updates unavailable' };
    default: return common;
  }
}

export function modelPresentation(model = {}) {
  const common = { state: model.state, title: 'Set up the local model', percent: progress(model.percent), message: text(model.message), visible: true, busy: false, label: 'Set up local model' };
  switch (model.state) {
    case 'ready': return { ...common, visible: false, label: 'Local model ready' };
    case 'installing': return { ...common, title: 'Preparing the local model', busy: true, label: 'Starting local model…' };
    case 'error': return { ...common, title: model.phase === 'runtime' ? 'Restart the local model' : model.phase === 'setup' ? 'Set up the local model' : 'Local model needs attention', label: 'Retry local model' };
    case 'missing': return common;
    default: return { ...common, visible: false, busy: true, label: 'Checking local model…' };
  }
}

// The same palettes and names as flusso.stream's Display settings.
export const THEME_OPTIONS = Object.freeze([
  { mode: 'system', label: 'System', description: 'Classic Light or Dark, following this computer.' },
  { mode: 'classic', label: 'Classic Light', description: 'Warm paper and teal, the original Flusso look.' },
  { mode: 'classic-dark', label: 'Classic Dark', description: 'The warm palette after dark.' },
  { mode: 'graphite', label: 'Graphite', description: 'Cool greys and a restrained slate blue.' },
  { mode: 'atlantic', label: 'Atlantic', description: 'Deep navy with a clear cerulean accent.' },
  { mode: 'nocturne', label: 'Nocturne', description: 'Plum-dark with a heliotrope accent.' },
  { mode: 'evergreen', label: 'Evergreen', description: 'Deep spruce with a fresh mint accent.' },
  { mode: 'heather', label: 'Heather', description: 'Lavender-grey paper with a quiet plum accent.' },
  { mode: 'midnight', label: 'Midnight', description: 'True black with the classic teal.' },
]);

export function resolveTheme(mode, prefersDark = false) {
  if (mode === 'system' || !THEME_OPTIONS.some(option => option.mode === mode)) return prefersDark ? 'classic-dark' : 'classic';
  return mode;
}

export function entryStatus(entry) {
  if (!entry?.ticket) return null;
  return entry.ticket.error ? { label: 'ticket error', tone: 'warn' } : { label: entry.ticket.kind === 'close' ? 'close ticket' : 'order ticket', tone: 'info' };
}

// Reconciliation keys contain only what the card or source-owned reader shows.
// Periodic review annotations update their own status regions, not the note.
export function entryCardPresentation(entry, { book = '', time = '', selected = false } = {}) {
  const ticket = entryStatus(entry), result = listenerResult(entry), revision = listenerRevisionPresentation(entry);
  const check = !entry.ticket && entry.listener?.status === 'observed' && entry.listenerCheck ? activityStatus(entry.listenerCheck) : null;
  return {
    id: entry.id, origin: entry.origin, title: entry.title, status: entry.status,
    book, time, selected,
    outcome: entry.ticket?.error ? ticket : result && { label: `${check ? 'Earlier response: ' : ''}${result.label}${revision ? ` · ${revision.label}` : ''}`, tone: check ? '' : result.tone },
    check,
  };
}

export function listenerRevisionPresentation(entry) {
  if (!entry?.listener) return null;
  const version = entry.listener.version, current = entry.version;
  if (!Number.isSafeInteger(version) || version < 1) return { label: 'revision unknown', note: 'The entry revision for this result was not recorded.' };
  if (version === current) return null;
  const knownCurrent = Number.isSafeInteger(current) && current > 0;
  return {
    label: `${knownCurrent && version < current ? 'prior ' : ''}v${formatCount(version)}`,
    note: `This result is for entry v${formatCount(version)}.${knownCurrent ? ` You are reading v${formatCount(current)}.` : ' The current entry revision is unavailable.'}`,
  };
}

export function entryReadingCore(entry, book = '') {
  return {
    id: entry.id, origin: entry.origin, title: entry.title, body: entry.body,
    status: entry.status, version: entry.version, updatedAtUtc: entry.updatedAtUtc,
    signal: entry.signal ?? null, book,
  };
}

const RESULT = { submitted: ['submitted', 'pos'], partial: ['partly submitted', 'warn'], blocked: ['refused', 'neg'], unknown: ['unconfirmed', 'warn'], pending: ['submitting', 'info'], sending: ['submitting', 'info'], processing: ['reviewing', 'info'], review: ['not submitted', 'warn'], waiting: ['waiting', 'warn'], resolved: ['owner resolved', ''] };
const DECISION = { candidate: ['flagged', 'info'], review: ['review suggested', 'info'], ignore: ['no action', ''], ticket: ['ticket', 'info'] };
export function activityStatus(row = {}, { historical = false } = {}) {
  if (historical && row.kind === 'research_check' && ['waiting', 'processing'].includes(row.status)) return { label: row.reviewStatus === 'failed' ? 'earlier check failed' : 'earlier check unfinished', tone: '' };
  if (row.kind === 'research_check' && row.status === 'waiting') return { label: row.reviewStatus === 'failed' ? 'check failed' : 'check unfinished', tone: 'warn' };
  if (row.status === 'processing' && row.decision !== 'ticket' && row.activeReview !== true) return { label: 'check unfinished', tone: 'warn' };
  const [label, tone] = RESULT[row.status] ?? (row.status === 'observed' ? DECISION[row.decision] : null) ?? [text(row.status) || 'noted', ''];
  return { label, tone };
}

export function activityReason(row = {}) {
  if (typeof row.reason === 'string' && row.reason.trim()) return row.reason;
  return row.status === 'observed' ? 'No reason was recorded for this result.' : row.status === 'processing' ? 'Review in progress; no response is recorded.' : 'No detail was recorded for this check.';
}

export function reviewFocusPresentation(focus, { prepared = false } = {}) {
  if (!focus || !['default', 'custom'].includes(focus.kind) || typeof focus.text !== 'string' || !focus.text.trim()) return { label: 'Review focus unavailable', text: 'The effective focus was not recorded for this response.' };
  return { label: `${prepared ? 'Prepared focus' : 'Review focus'}: ${focus.kind === 'default' ? 'Default research review' : 'Custom'}`, text: focus.text };
}

export function receiptDetails(line = {}) {
  const code = text(line.riskCode);
  return { message: text(line.message), riskCode: /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : null };
}

// What the listener did with an entry's ticket, as one word and a filter group.
const LISTENER_RESULT = {
  submitted: ['submitted', 'pos', 'placed'], partial: ['partly submitted', 'warn', 'placed'],
  blocked: ['refused', 'neg', 'refused'], review: ['not submitted', 'warn', 'refused'],
  waiting: ['waiting', 'warn', 'open'], sending: ['submitting', 'info', 'open'], pending: ['submitting', 'info', 'open'], processing: ['reviewing', 'info', 'open'],
  unknown: ['unconfirmed', 'warn', 'open'], observed: ['seen', '', 'open'], resolved: ['owner resolved', '', 'resolved'],
};
export function listenerResult(entry) {
  if (!entry?.ticket && !entry?.listener) return null;
  if (!entry.ticket && entry.listener?.status === 'processing' && entry.listener.activeReview !== true) return { ...activityStatus(entry.listener), group: 'open' };
  if (!entry.ticket && entry.listener?.kind === 'research_check' && entry.listener.status === 'waiting') return { ...activityStatus(entry.listener, { historical: entry.listener.version < entry.version }), group: 'open' };
  if (!entry.ticket && entry.listener?.status === 'observed') {
    const result = activityStatus(entry.listener);
    return { ...result, group: 'decided' };
  }
  const [label, tone, group] = LISTENER_RESULT[entry.listener?.status] ?? ['not actioned', '', 'open'];
  return { label, tone, group };
}
export const RESULT_FILTERS = Object.freeze([
  { value: '', label: 'All entries' }, { value: 'tickets', label: 'Order tickets' },
  { value: 'placed', label: 'Submitted' }, { value: 'refused', label: 'Refused or not submitted' }, { value: 'open', label: 'Awaiting a result' }, { value: 'decided', label: 'Model reviews' }, { value: 'resolved', label: 'Owner resolved' },
]);
export function matchesResultFilter(entry, filter) {
  if (!filter) return true;
  const result = listenerResult(entry);
  if (!result) return false;
  return filter === 'tickets' ? Boolean(entry.ticket) : result.group === filter;
}

const STAGES = Object.freeze({ start: 'Start check', sync: 'Read Journal', reconcile: 'Check earlier orders', queued: 'Queued', read: 'Read entry', model: 'Model review', model_ready: 'Model ready', decision: 'Decision', validate: 'Check limits', waiting: 'Waiting', submit: 'Submit', result: 'Result', error: 'Needs attention', idle: 'Idle', paused: 'Paused' });
export function processStage(stage) { return STAGES[stage] ?? 'Activity'; }

// A counted position is shown only when the Listener reported both whole numbers.
function position(current) {
  const { index, total } = current ?? {};
  return Number.isInteger(index) && Number.isInteger(total) && index >= 1 && total >= index ? { index, total } : null;
}

// `state` is the one coarse word a person scans for; `label` keeps the exact stage.
export function processingPresentation(listener = {}, enabled = false, { disconnected = false } = {}) {
  const current = listener.processing;
  if (disconnected) return { state: 'disconnected', title: 'Reconnecting', label: 'Status unavailable', message: 'Live status is unavailable. Showing the last reported state; the Listener may still be running.', tone: 'warn', busy: false, position: null };
  if (listener.busy) {
    const error = current?.stage === 'error';
    return { state: error ? 'error' : 'reviewing', title: error ? 'Needs attention' : 'Reading', label: processStage(current?.stage), message: text(current?.message) || 'Checking Journal entries.', tone: error ? 'warn' : 'info', busy: true, position: position(current) };
  }
  if (!enabled) return { state: 'off', title: 'Off', label: 'Listener off', message: 'Turn on the Listener to run a check.', tone: '', busy: false, position: null };
  if (listener.lastError) return { state: 'error', title: listener.modelReview?.status === 'failed' ? 'Check failed' : 'Needs attention', label: 'Needs attention', message: text(listener.lastError), tone: 'warn', busy: false, position: null };
  if (listener.modelRecovery) return { state: 'ready', title: 'Model ready', label: 'Model ready', message: text(current?.message), tone: '', busy: false, position: null };
  if (listener.modelReview?.restored && listener.modelReview.status === 'failed') return { state: 'error', title: 'Check failed', label: 'Check failed', message: text(listener.modelReview.reason), tone: 'warn', busy: false, position: null };
  if (listener.modelReview?.restored && listener.modelReview.status === 'stopped') return { state: 'paused', title: 'Check unfinished', label: 'Check unfinished', message: text(listener.modelReview.reason), tone: 'warn', busy: false, position: null };
  if (current?.stage === 'paused') return { state: 'paused', title: 'Paused', label: 'Paused', message: text(current.message) || 'The last check paused before it finished.', tone: 'warn', busy: false, position: null };
  if (listener.modelReview?.status === 'not_run') return { state: 'ready', title: 'No model run', label: 'No model run', message: text(listener.modelReview.reason), tone: '', busy: false, position: null };
  if (listener.modelReview?.status === 'skipped') return { state: 'paused', title: 'Review skipped', label: 'Review skipped', message: text(listener.modelReview.reason), tone: 'warn', busy: false, position: null };
  const checked = Boolean(listener.lastCheckedAtUtc);
  return { state: checked ? 'complete' : 'ready', title: checked ? 'Checked' : 'Ready', label: checked ? 'Check complete' : 'Ready', message: text(current?.message) || 'Waiting for the next check.', tone: '', busy: false, position: null };
}

const INTERVALS = [[3600, 'hour'], [60, 'minute'], [1, 'second']];
export function intervalLabel(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  const [size, unit] = INTERVALS.find(([size]) => seconds % size === 0);
  const count = seconds / size;
  return `${formatCount(count)} ${unit}${count === 1 ? '' : 's'}`;
}

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
// Reads the model's own `reason` string from its JSON answer while it streams.
// Only complete escapes are decoded; anything other than the start of an object
// of string fields returns null so the raw text is shown uninterpreted instead.
// `reason` is null until that string begins. Display only: the server's parse of
// the finished response remains the sole authority for any decision.
export function streamedReason(source) {
  if (typeof source !== 'string') return null;
  const n = source.length;
  let i = 0, reason = null;
  const space = () => { while (i < n && ' \t\n\r'.includes(source[i])) i += 1; };
  const string = () => {
    let value = ''; i += 1;
    while (i < n) {
      const c = source[i];
      if (c === '"') { i += 1; return { value, done: true }; }
      if (c < ' ') return null;
      if (c !== '\\') { value += c; i += 1; continue; }
      const escape = source[i + 1];
      if (escape === undefined) break;
      if (escape === 'u') {
        const hex = source.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
        if (hex.length < 4) break;
        value += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
      }
      if (!(escape in ESCAPES)) return null;
      value += ESCAPES[escape]; i += 2;
    }
    // Half of a surrogate pair waits for the rest rather than rendering as a broken glyph.
    return { value: value.replace(/[\uD800-\uDBFF]$/, ''), done: false };
  };
  space();
  if (i >= n) return { reason };
  if (source[i] !== '{') return null;
  i += 1;
  for (let first = true; ; first = false) {
    space(); if (i >= n) return { reason };
    if (source[i] === '}') { i += 1; space(); return i >= n ? { reason } : null; }
    if (!first) { if (source[i] !== ',') return null; i += 1; space(); if (i >= n) return { reason }; }
    if (source[i] !== '"') return null;
    const key = string(); if (!key) return null; if (!key.done) return { reason };
    space(); if (i >= n) return { reason };
    if (source[i] !== ':') return null;
    i += 1; space(); if (i >= n) return { reason };
    if (source[i] !== '"') return null;
    const value = string(); if (!value) return null;
    // A repeated key replaces the earlier one, as JSON.parse does.
    if (key.value === 'reason') reason = value.value;
    if (!value.done) return { reason };
  }
}

const OUTPUT_STATUS = { streaming: ['Streaming', 'info'], complete: ['Complete', ''], failed: ['Check failed', 'warn'], stopped: ['Check unfinished', 'warn'] };
// The streamed text is kept exactly as received. Until that same run completes and
// the Listener publishes its validated decision, only the model's own reason words
// are lifted out of it, as a draft that is never labelled or styled as a decision.
export function modelOutputPresentation(output, published = null, { disconnected = false, enabled = false, busy = false } = {}) {
  if (!output) {
    const empty = !enabled ? 'Turn the Listener on to begin. Each period re-checks the newest selected research note and reviews new Watching research revisions. Real responses stream here.'
      : busy ? 'Reading the Journal. The model’s response appears here as soon as it starts.'
        : 'Choose Check now to review selected research. Each period re-checks the newest note and also reviews new Watching research revisions.';
    return { status: 'none', label: 'Not run', tone: '', live: false, accepted: false, verdict: null, draft: null, draftLabel: null, note: null, empty };
  }
  const [label, tone] = OUTPUT_STATUS[output.status] ?? ['Unavailable', 'warn'];
  const live = output.status === 'streaming' && !disconnected;
  const startedAt = Date.parse(output.atUtc), publishedAt = Date.parse(published?.atUtc);
  const accepted = output.status === 'complete' && Boolean(published) && published.entryId === output.entryId && published.origin === output.origin
    && (output.version == null && published.version == null || Number.isSafeInteger(output.version) && output.version > 0 && output.version === published.version)
    && (output.checkId == null && published.checkId == null || output.checkId === published.checkId)
    && ['candidate', 'review', 'ignore'].includes(published.decision)
    && Number.isFinite(startedAt) && Number.isFinite(publishedAt) && publishedAt >= startedAt;
  const verdict = accepted ? { ...activityStatus({ status: 'observed', decision: published.decision }), reason: text(published.reason) } : null;
  const hasText = Boolean(output.text);
  // While streaming, a readable answer holds its place even before the reason begins.
  // Otherwise the draft needs real reason text; an unreadable answer stays raw.
  const reading = !accepted && hasText ? streamedReason(output.text) : null;
  const draft = !reading ? null : output.status === 'streaming' ? reading.reason ?? '' : reading.reason || null;
  const draftLabel = draft === null ? null : output.status === 'streaming' ? 'Reason so far' : output.status === 'complete' ? 'Model reason' : 'Partial reason';
  const note =output.status === 'streaming' ? (disconnected ? 'Reconnecting. Showing the last output received; nothing is accepted until the response completes.' : 'Format check pending. This is the model’s partial response, not a completed decision.')
    : ['failed', 'stopped'].includes(output.status) ? (hasText ? 'Partial output shown. It was not accepted as a decision.' : 'No output was received. Nothing was accepted.')
      : output.status === 'complete' && !accepted ? 'The response completed, but no accepted local decision matches it.' : null;
  const empty = hasText ? null : output.status === 'streaming' ? 'Waiting for the model’s first response token.' : 'No model response was received.';
  return { status: output.status, label: disconnected && output.status === 'streaming' ? 'Reconnecting' : label, tone, live, accepted, verdict, draft, draftLabel, note, empty };
}

export function modelCoverageLabel(coverage, { received = false, detail = false } = {}) {
  if (!coverage || coverage.unit !== 'UTF-16' || !Number.isSafeInteger(coverage.bodyUnits) || !Number.isSafeInteger(coverage.totalBodyUnits)
    || coverage.bodyUnits < 0 || coverage.totalBodyUnits < coverage.bodyUnits) return 'Review coverage unavailable';
  if (!detail) return `${coverage.bodyTruncated ? 'Note excerpt' : 'Full note'} ${received ? 'supplied' : 'prepared'}`;
  return coverage.bodyTruncated
    ? received ? `Excerpt only: first ${formatCount(coverage.bodyUnits)} of ${formatCount(coverage.totalBodyUnits)} UTF-16 text units. The rest was not sent to the model.`
      : `Prepared excerpt: first ${formatCount(coverage.bodyUnits)} of ${formatCount(coverage.totalBodyUnits)} UTF-16 text units. Remaining text is excluded from this review.`
    : `${received ? 'Full note body supplied' : 'Prepared note body'} · ${formatCount(coverage.bodyUnits)} UTF-16 text units`;
}

export function latestCheckPresentation(listener = {}) {
  const review = listener.modelReview;
  if (listener.busy || !review || !['failed', 'stopped', 'skipped'].includes(review.status)) return null;
  const finished = Number.isFinite(Date.parse(review.completedAtUtc)), clock = finished ? review.completedAtUtc : review.startedAtUtc;
  return { label: review.status === 'failed' ? 'Check failed' : review.status === 'stopped' ? 'Check unfinished' : 'Research review skipped',
    reason: text(review.reason) || text(listener.lastError) || 'No completed result was recorded for this check.',
    clock: Number.isFinite(Date.parse(clock)) ? clock : null, clockLabel: finished ? 'Finished' : 'Recorded' };
}

export function activityMetadata(row, source = null) {
  const revision = listenerRevisionPresentation({ version: source?.version, listener: row })?.label
    ?? (Number.isSafeInteger(row.version) && row.version > 0 ? `v${formatCount(row.version)}` : 'revision unknown');
  const completed = row.status === 'observed' && Number.isFinite(Date.parse(row.completedAtUtc)), finished = row.kind === 'research_check' && ['failed', 'stopped'].includes(row.reviewStatus) && Number.isFinite(Date.parse(row.completedAtUtc));
  return { revision, clock: completed || finished ? row.completedAtUtc : row.atUtc, clockLabel: completed ? 'Completed' : finished ? 'Finished' : 'Recorded',
    historical: Boolean(source && Number.isSafeInteger(row.version) && row.version > 0 && row.version < source.version) };
}

// lastModelOutput is written only after the model response and settings pass the
// server's checks. Keep its source and revision distinct from a later live run.
export function completedModelPresentation(listener = {}, entries = []) {
  const output = listener.lastModelOutput;
  if (!output || !['review', 'ignore', 'candidate'].includes(output.decision) || !Number.isFinite(Date.parse(output.atUtc))) return null;
  const source = entries.find(row => row.id === output.entryId && row.origin === output.origin);
  const earlier = listener.modelReview?.id != null && output.checkId !== listener.modelReview.id
    || listener.modelOutput?.status === 'streaming' || source?.version !== output.version || source?.handoff?.context?.inScope === false;
  const revision = Number.isSafeInteger(output.version) && output.version > 0 ? `v${formatCount(output.version)}` : 'revision unknown';
  const scope = source?.handoff?.context?.inScope;
  const current = !source ? 'Source not loaded' : output.version !== source.version ? `Current note is v${formatCount(source.version)}` : 'Same note revision';
  const status = { watching: 'Watching note', reviewed: 'Reviewed note', closed: 'Closed note' }[source?.status];
  return { output, earlier, ...activityStatus({ status: 'observed', decision: output.decision }), reason: activityReason({ ...output, status: 'observed' }),
    context: `${revision} · ${current}${status ? ` · ${status}` : ''}${scope === false ? ' · Outside selected filters' : scope === true ? ' · Matches selected filters' : ''}` };
}

// Keep this identity across streaming/idle updates. A new clock alone is not a
// changed outcome; an actual changed decision, reason, source, or error is.
export function completionAnnouncement(view, output, previousKey = null, error = null) {
  const identity = [output?.origin, output?.entryId, output?.version];
  const outcome = error ? ['error', ...identity, error]
    : view.accepted ? ['accepted', ...identity, view.verdict.label, view.verdict.reason]
      : ['failed', 'stopped'].includes(view.status) ? [view.status, ...identity] : null;
  if (!outcome) return null;
  const key = JSON.stringify(outcome);
  if (key === previousKey) return null;
  return { key, message: error ? `${view.status === 'failed' ? 'Check failed' : 'Check needs attention'}. ${error}`
    : view.accepted ? `Review complete: ${view.verdict.label}.` : `${view.label}. No decision was accepted.` };
}

// Compare the actual fields, without trimming away meaningful writing changes.
export function localDraftDirty(base, current) {
  return base !== null && ['notebookId', 'title', 'body', 'status', 'signal'].some(field => base[field] !== current[field]);
}

export function latestDecisions(activity = [], output = null, { limit = 5 } = {}) {
  const rows = [...activity];
  // Activity clocks the model's start; its published output clocks completion.
  // Keep every retained revision and suppress only its duplicate output summary.
  const retained = output && rows.some(row => row.status === 'observed' && row.entryId === output.entryId && row.origin === output.origin
    && row.decision === output.decision && row.reason === output.reason
    && (output.version == null || row.version === output.version));
  if (output && !retained) rows.unshift({ ...output, status: 'observed' });
  // A later paused or refused check must remain above an earlier published answer.
  const clock = row => { const value = Date.parse(row.atUtc); return Number.isFinite(value) ? value : -Infinity; };
  const unconfirmed = row => ['pending', 'unknown'].includes(row.status);
  rows.sort((a, b) => Number(unconfirmed(b)) - Number(unconfirmed(a)) || clock(b) - clock(a));
  return limit === null ? rows : rows.slice(0, limit);
}

// Only the same validated research result is redundant with the response desk.
// Activity records its start clock; a synthetic summary records completion.
export function decisionShownInDesk(row, output, published, { completed = false, failure = null } = {}) {
  if (failure?.checkId != null && output?.activityId != null && row.kind === 'research_check' && row.status === 'waiting' && row.reviewStatus === 'failed'
    && output?.status === 'failed' && output.checkId === failure.checkId && row.checkId === failure.checkId
    && row.id === output.activityId && row.entryId === output.entryId && row.origin === output.origin
    && Number.isSafeInteger(output.version) && output.version > 0 && row.version === output.version && row.reason === failure.reason) return true;
  const displayedCheck = completed && published?.activityId != null && published?.checkId != null
    && row.id === published.activityId && row.checkId === published.checkId;
  return Boolean((displayedCheck || modelOutputPresentation(output, published).accepted) && row.status === 'observed'
    && ['candidate', 'review', 'ignore'].includes(row.decision)
    && Number.isSafeInteger(published?.version) && published.version > 0 && (displayedCheck || output?.version === published.version)
    && row.entryId === published.entryId && row.origin === published.origin && row.version === published.version
    && row.decision === published.decision && row.reason === published.reason
    && (displayedCheck || row.atUtc === output?.atUtc || row.id == null && row.atUtc === published.atUtc));
}

// Activity IDs survive status/receipt updates. Published summaries have no ID;
// their clock and outcome distinguish them from a later check of the same note.
export function decisionRowKeys(rows) {
  const occurrences = new Map();
  return rows.map(row => {
    const identity = JSON.stringify(row.id != null ? ['activity', row.id] : ['summary', row.origin, row.entryId, row.version, row.atUtc, row.status, row.decision]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return `${identity}:${occurrence}`;
  });
}

// The API accepts a complete versioned settings body. A switch must carry only
// the last saved values, never fields from the still-unsaved configuration form.
export function settingsSwitchBody(settings, field, value) {
  if (!['enabled', 'executionEnabled'].includes(field) || typeof value !== 'boolean') throw new Error('Invalid settings switch.');
  const keys = ['version', 'enabled', 'executionEnabled', 'source', 'notebookIds', 'section', 'instructions', 'intervalSeconds', 'maxSignalAgeSeconds', 'maxTicketsPerDay', 'writeBack', 'accountId', 'risk'];
  return { ...Object.fromEntries(keys.map(key => [key, settings[key]])), [field]: value };
}

// Start with an empty action, as close-ticket drafts already do. Only the owner
// supplies executable order terms or exact owned position IDs.
export function ticketDraft(id, close = false) {
  return close ? { id, positionIds: [] } : { id, together: true, orders: [] };
}
