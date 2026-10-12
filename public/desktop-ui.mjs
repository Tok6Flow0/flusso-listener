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
