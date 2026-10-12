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
  return entry.ticket.error ? { label: 'ticket error', tone: 'warn' } : { label: 'order ticket', tone: 'info' };
}

const RESULT = { submitted: ['sent', 'pos'], partial: ['partly sent', 'warn'], blocked: ['refused', 'neg'], unknown: ['unconfirmed', 'warn'], pending: ['sending', 'info'], sending: ['sending', 'info'], review: ['held', 'warn'] };
const DECISION = { candidate: ['flagged', 'info'], review: ['review', ''], ignore: ['ignored', ''], ticket: ['ticket', 'info'] };
export function activityStatus(row = {}) {
  const [label, tone] = RESULT[row.status] ?? (row.status === 'observed' ? DECISION[row.decision] : null) ?? [text(row.status) || 'noted', ''];
  return { label, tone };
}
