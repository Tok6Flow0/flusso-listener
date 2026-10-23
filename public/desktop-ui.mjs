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
  const common = { percent: progress(model.percent), message: text(model.message), visible: true, busy: false, label: 'Set up local model' };
  switch (model.state) {
    case 'ready': return { ...common, visible: false, label: 'Local model ready' };
    case 'installing': return { ...common, busy: true, label: 'Setting up local model…' };
    case 'error': return { ...common, label: 'Retry model setup' };
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

const RESULT = { submitted: ['submitted', 'pos'], partial: ['partly submitted', 'warn'], blocked: ['refused', 'neg'], unknown: ['unconfirmed', 'warn'], pending: ['submitting', 'info'], sending: ['submitting', 'info'], processing: ['reviewing', 'info'], review: ['not submitted', 'warn'], waiting: ['waiting', 'warn'], resolved: ['owner resolved', ''] };
const DECISION = { candidate: ['flagged', 'info'], review: ['needs attention', 'warn'], ignore: ['no action', ''], ticket: ['ticket', 'info'] };
export function activityStatus(row = {}) {
  const [label, tone] = RESULT[row.status] ?? (row.status === 'observed' ? DECISION[row.decision] : null) ?? [text(row.status) || 'noted', ''];
  return { label, tone };
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
  unknown: ['unconfirmed', 'warn', 'open'], observed: ['seen', '', 'open'], resolved: ['owner resolved', '', 'refused'],
};
export function listenerResult(entry) {
  if (!entry?.ticket && !entry?.listener) return null;
  if (!entry.ticket && entry.listener?.status === 'observed') {
    const result = activityStatus(entry.listener);
    return { ...result, group: 'open' };
  }
  const [label, tone, group] = LISTENER_RESULT[entry.listener?.status] ?? ['not actioned', '', 'open'];
  return { label, tone, group };
}
export const RESULT_FILTERS = Object.freeze([
  { value: '', label: 'All entries' }, { value: 'tickets', label: 'Order tickets' },
  { value: 'placed', label: 'Submitted' }, { value: 'refused', label: 'Refused or not submitted' }, { value: 'open', label: 'Awaiting a result' },
]);
export function matchesResultFilter(entry, filter) {
  if (!filter) return true;
  const result = listenerResult(entry);
  if (!result) return false;
  return filter === 'tickets' ? Boolean(entry.ticket) : result.group === filter;
}

const STAGES = Object.freeze({ sync: 'Read Journal', reconcile: 'Check earlier orders', queued: 'Queued', read: 'Read entry', model: 'Model review', decision: 'Decision', validate: 'Check limits', waiting: 'Waiting', submit: 'Submit', result: 'Result', error: 'Needs attention', idle: 'Idle', paused: 'Paused' });
export function processStage(stage) { return STAGES[stage] ?? 'Activity'; }

// A counted position is shown only when the Listener reported both whole numbers.
function position(current) {
  const { index, total } = current ?? {};
  return Number.isInteger(index) && Number.isInteger(total) && index >= 1 && total >= index ? { index, total } : null;
}

// `state` is the one coarse word a person scans for; `label` keeps the exact stage.
export function processingPresentation(listener = {}, enabled = false) {
  const current = listener.processing;
  if (listener.busy) {
    const error = current?.stage === 'error';
    return { state: error ? 'error' : 'reviewing', title: error ? 'Needs attention' : 'Reading', label: processStage(current?.stage), message: text(current?.message) || 'Checking Journal entries.', tone: error ? 'warn' : 'info', busy: true, position: position(current) };
  }
  if (!enabled) return { state: 'off', title: 'Off', label: 'Listener off', message: 'Not watching your Journal.', tone: '', busy: false, position: null };
  if (listener.lastError) return { state: 'error', title: 'Needs attention', label: 'Needs attention', message: text(listener.lastError), tone: 'warn', busy: false, position: null };
  if (current?.stage === 'paused') return { state: 'paused', title: 'Paused', label: 'Paused', message: text(current.message) || 'The last check paused before it finished.', tone: 'warn', busy: false, position: null };
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

const OUTPUT_STATUS = { streaming: ['Streaming', 'info'], complete: ['Complete', 'pos'], failed: ['Failed', 'warn'], stopped: ['Stopped', 'warn'] };
// The streamed text is shown exactly as received. A readable decision appears only
// when that same run completed and the Listener published its validated decision.
export function modelOutputPresentation(output, published = null, { disconnected = false, enabled = false, busy = false } = {}) {
  if (!output) {
    const empty = !enabled ? 'Turn the Listener on to begin. Each check reviews the newest selected research note, and the model’s real response streams here.'
      : busy ? 'Reading the Journal. The model’s response appears here as soon as it starts.'
        : 'Nothing reviewed yet. Choose Check now to review the newest selected research note.';
    return { status: 'none', label: 'Not run', tone: '', live: false, accepted: false, verdict: null, note: null, empty };
  }
  const [label, tone] = OUTPUT_STATUS[output.status] ?? ['Unavailable', 'warn'];
  const live = output.status === 'streaming' && !disconnected;
  const startedAt = Date.parse(output.atUtc), publishedAt = Date.parse(published?.atUtc);
  const accepted = output.status === 'complete' && Boolean(published) && published.entryId === output.entryId && published.origin === output.origin
    && ['candidate', 'review', 'ignore'].includes(published.decision)
    && Number.isFinite(startedAt) && Number.isFinite(publishedAt) && publishedAt >= startedAt;
  const verdict = accepted ? { ...activityStatus({ status: 'observed', decision: published.decision }), reason: text(published.reason) } : null;
  const hasText = Boolean(output.text);
  const note = output.status === 'streaming' ? (disconnected ? 'Reconnecting. Showing the last output received; nothing is accepted until the response completes.' : 'Partial output. Nothing is accepted until the response completes and passes validation.')
    : ['failed', 'stopped'].includes(output.status) ? (hasText ? 'Partial output shown. It was not accepted as a decision.' : 'No output was received. Nothing was accepted.')
      : output.status === 'complete' && !accepted ? 'The response completed, but no published decision matches it.' : null;
  const empty = hasText ? null : output.status === 'streaming' ? 'Waiting for the model’s first response token.' : 'The model returned no response.';
  return { status: output.status, label: disconnected && output.status === 'streaming' ? 'Reconnecting' : label, tone, live, accepted, verdict, note, empty };
}

export function latestDecisions(activity = [], output = null) {
  const rows = [...activity];
  // Activity clocks the model's start; its published output clocks completion.
  // Keep every retained revision and suppress only its duplicate output summary.
  const retained = output && rows.some(row => row.entryId === output.entryId && row.origin === output.origin
    && row.decision === output.decision && row.reason === output.reason
    && (output.version == null || row.version === output.version));
  if (output && !retained) rows.unshift({ ...output, status: 'observed' });
  // A later paused or refused check must remain above an earlier published answer.
  const clock = row => { const value = Date.parse(row.atUtc); return Number.isFinite(value) ? value : -Infinity; };
  const unconfirmed = row => ['pending', 'unknown'].includes(row.status);
  return rows.sort((a, b) => Number(unconfirmed(b)) - Number(unconfirmed(a)) || clock(b) - clock(a)).slice(0, 5);
}

// The API accepts a complete versioned settings body. A switch must carry only
// the last saved values, never fields from the still-unsaved configuration form.
export function settingsSwitchBody(settings, field, value) {
  if (!['enabled', 'executionEnabled'].includes(field) || typeof value !== 'boolean') throw new Error('Invalid settings switch.');
  const keys = ['version', 'enabled', 'executionEnabled', 'source', 'notebookIds', 'section', 'instructions', 'intervalSeconds', 'maxSignalAgeSeconds', 'maxTicketsPerDay', 'writeBack', 'accountId', 'risk'];
  return { ...Object.fromEntries(keys.map(key => [key, settings[key]])), [field]: value };
}
