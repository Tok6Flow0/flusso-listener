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
const DECISION = { candidate: ['flagged', 'info'], review: ['review needed', 'warn'], ignore: ['no action', ''], ticket: ['ticket', 'info'] };
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

export function processingPresentation(listener = {}, enabled = false) {
  const current = listener.processing;
  if (listener.busy) return { label: processStage(current?.stage), message: text(current?.message) || 'Checking Journal entries.', tone: current?.stage === 'error' ? 'warn' : 'info', busy: true };
  if (!enabled) return { label: 'Listener off', message: 'Turn on the Listener to read new Journal entries.', tone: '', busy: false };
  if (listener.lastError) return { label: 'Needs attention', message: text(listener.lastError), tone: 'warn', busy: false };
  return { label: listener.lastCheckedAtUtc ? 'Check complete' : 'Ready', message: text(current?.message) || 'Waiting for the next check.', tone: '', busy: false };
}

export function latestDecisions(activity = [], output = null) {
  const rows = [...activity];
  // Activity clocks the model's start; its published output clocks completion.
  // Keep every retained revision and suppress only its duplicate output summary.
  const retained = output && rows.some(row => row.entryId === output.entryId && row.origin === output.origin
    && row.decision === output.decision && row.reason === output.reason
    && (output.version == null || row.version === output.version));
  if (output && !retained) rows.unshift({ ...output, status: 'observed' });
  return rows.slice(0, 5);
}
