import { formatCount, formatPrice, formatQuantity, formatPercentLabel, formatMoney, formatPercent } from './format.mjs';
import { renderMarkdown } from './markdown.mjs';
import { accountPresentation, updatePresentation, modelPresentation, THEME_OPTIONS, resolveTheme, entryStatus, entryCardPresentation, entryReadingCore, activityStatus, activityReason, reviewFocusPresentation, activityMetadata, listenerResult, listenerRevisionPresentation, RESULT_FILTERS, matchesResultFilter, processStage, processingPresentation, latestDecisions, decisionShownInDesk, decisionRowKeys, receiptDetails, modelOutputPresentation, completedModelPresentation, modelCoverageLabel, completionAnnouncement, localDraftDirty, intervalLabel, settingsSwitchBody, ticketDraft } from './desktop-ui.mjs';

const $ = id => document.getElementById(id);
let csrf, snapshot, selected = null, editing = null, entryRetryKey = crypto.randomUUID();
const desktop = window.flussoDesktop;
let desktopStatus = null, connectionBusy = false, connectionOperation = null, connectionGeneration = 0, profileConnectionKey = null, profileGeneration = 0, dismissedUpdate = null;
let accounts = [], accountsKey = null, formDirty = false, settingsEdit = 0, riskValidationActive = false, themeMode = document.documentElement.dataset.themeMode || 'system';
const nativeTasks = new Set();
const renderKeys = new Map();
let pollBusy = false, lastPolledAt = 0;
const TICKET_EXAMPLE = { id: 'kaia-2026-10-12T14', together: true, orders: [
  { instrumentId: 'gate:KAIA_USDT', side: 'buy', quantity: 120, limitPrice: 0.1234, conditions: { maxSlippagePct: 3 } },
  { instrumentId: 'bybit:KAIAUSDT', side: 'sell', quantity: 12, limitPrice: 0.1236, conditions: { maxSlippagePct: 3 } },
] };
const TICKET_FENCE = /^(```|~~~)[ \t]*flusso-(?:orders|close)[ \t]*\n[\s\S]*?^\1[ \t]*$/gm;

function element(tag, content, className) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (tag === 'time' || className?.split(' ').includes('interface-numbers')) node.dataset.interfaceNumbers = 'true';
  if (content != null) { if (node.dataset.interfaceNumbers === 'true') interfaceText(node, content); else node.textContent = content; }
  return node;
}
function pill(text, tone) { return element('span', text, `pill${tone ? ' ' + tone : ''}`); }
function notify(message, success = false, error = false, { reveal: showError = true } = {}) {
  const notice = $('notice'), className = `notice${error ? ' error' : success ? ' success' : ''}`;
  notify.pollMessage = null;
  if (!notice.hidden && $('notice-text').textContent === message && notice.className === className) return;
  $('notice-text').textContent = message; notice.hidden = false; notice.className = className;
  cancelAnimationFrame(notify.frame); $('notice-status').textContent = ''; $('notice-alert').textContent = '';
  notify.frame = requestAnimationFrame(() => { $(error ? 'notice-alert' : 'notice-status').textContent = message; });
  clearTimeout(notify.timer); if (success) notify.timer = setTimeout(() => { $('notice').hidden = true; }, 5000);
  if (error && showError) {
    const bounds = notice.getBoundingClientRect(), top = matchMedia('(max-width:760px)').matches ? document.querySelector('.sidebar').getBoundingClientRect().bottom : 0;
    if (bounds.top < top || bounds.bottom > window.innerHeight) notice.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}
function recoverPollNotice() {
  notify.pollFailure = null;
  $('refresh-status').hidden = true;
  if (!notify.pollMessage) return;
  if ($('notice-text').textContent === notify.pollMessage && $('notice').className === 'notice error') {
    $('notice').hidden = true; cancelAnimationFrame(notify.frame); $('notice-alert').textContent = '';
  }
  notify.pollMessage = null;
}
function notifyPollFailure(message) {
  setText('refresh-status', 'Not updating. Showing the last loaded state until Journal reconnects.'); $('refresh-status').hidden = false;
  if (notify.pollFailure === message) return;
  notify(message, false, true, { reveal: false }); notify.pollMessage = message; notify.pollFailure = message;
}
async function api(path, body, headers = {}) {
  let response;
  try { response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-flusso-csrf': csrf }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new Error('Journal could not reach its local service. Keep Journal running, or reopen it to reconnect.'); }
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'That did not work. Try again.'); return value;
}
async function action(button, work) { if (button?.disabled) return; if (button) button.disabled = true; try { await work(); } catch (error) { notify(error.message, false, true); } finally { if (button) button.disabled = false; } }
function when(value, seconds = false) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }) : '—'; }
function timeOf(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
function changed(key, value) { const next = JSON.stringify(value); if (renderKeys.get(key) === next) return false; renderKeys.set(key, next); return true; }
const rowViews = new WeakMap();
// Keep unchanged cards attached, including their focused controls, as new rows arrive.
function reconcileRows(list, items, render) {
  const previous = rowViews.get(list) ?? new Map(), next = new Map();
  const focused = document.activeElement, focusedRow = list.contains(focused) ? focused.closest('[data-row-key]') : null;
  const focusKey = focusedRow?.dataset.rowKey, control = focused?.dataset.rowControl;
  let cursor = list.firstChild;
  for (const item of items) {
    const revision = JSON.stringify(item.value), old = previous.get(item.key);
    const node = old?.revision === revision ? old.node : render(item.value);
    node.dataset.rowKey = item.key;
    if (!node.matches('button, a[href], input, select, textarea, summary, [tabindex]')) node.tabIndex = -1;
    next.set(item.key, { node, revision });
    if (old && old.node !== node) { if (cursor === old.node) cursor = old.node.nextSibling; old.node.remove(); }
    if (node !== cursor) list.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  for (const node of [...list.children]) if (!next.has(node.dataset.rowKey) || next.get(node.dataset.rowKey).node !== node) node.remove();
  rowViews.set(list, next);
  if (focusedRow && document.activeElement !== focused) {
    const row = next.get(focusKey)?.node;
    const target = row && (control && row.querySelector(`[data-row-control="${control}"]`) || row.querySelector('[data-row-control="source"]') || row);
    if (focused.isConnected) focused.focus({ preventScroll: true });
    else { list.tabIndex = -1; (target || list).focus({ preventScroll: true }); }
  }
}
function decisionItems(rows, details) {
  const keys = decisionRowKeys(rows);
  return rows.map((row, index) => ({ key: keys[index], value: { row, sourceAvailable: snapshot.entries.some(entry => entry.id === row.entryId && (!row.origin || row.origin === entry.origin)), ...details(row) } }));
}
// Writes only real changes, so live regions announce a state once rather than on every token.
function interfaceText(node, value) {
  if (node.textContent === value) return;
  node.replaceChildren(...value.split(/(\d+(?:[.,:]\d+)*)/g).map((part, index) => index % 2 ? element('span', part, 'mono') : document.createTextNode(part)));
}
function setText(id, value) {
  const node = $(id); if (node.textContent === value) return;
  if (node.dataset.interfaceNumbers === 'true') interfaceText(node, value); else node.textContent = value;
}
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function reveal(node, block = 'start') { node.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block }); }
$('dismiss-notice').addEventListener('click', () => { clearTimeout(notify.timer); $('notice').hidden = true; });

/* ------------------------------------------------------------ appearance */
function applyTheme(mode = themeMode) {
  themeMode = mode;
  const theme = resolveTheme(mode, matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.dataset.themeMode = mode;
  for (const button of $('theme-grid').children) { const selected = button.dataset.mode === mode; button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1; }
}
function renderThemes() {
  $('theme-grid').replaceChildren(...THEME_OPTIONS.map(option => {
    const button = element('button', null, 'theme-option'); button.type = 'button'; button.dataset.mode = option.mode; button.setAttribute('role', 'radio'); button.title = option.description;
    const swatch = palette => { const node = element('span', null, 'swatch'); node.dataset.theme = palette; node.append(element('i'), element('i', null, 'sw-surface'), element('i', null, 'sw-accent'), element('i', null, 'sw-ink')); return node; };
    if (option.mode === 'system') { const split = element('span', null, 'swatch-split'); split.append(swatch('classic'), swatch('classic-dark')); button.append(split); }
    else button.append(swatch(option.mode));
    button.append(element('span', option.label));
    button.addEventListener('click', () => action(null, async () => { applyTheme(option.mode); await api('/api/display', { theme: option.mode }); }));
    return button;
  }));
  applyTheme();
}
$('theme-grid').addEventListener('keydown', event => {
  const buttons = [...$('theme-grid').children], index = buttons.indexOf(event.target);
  if (index < 0) return;
  const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : delta ? (index + delta + buttons.length) % buttons.length : null;
  if (next === null) return;
  event.preventDefault(); buttons[next].focus(); buttons[next].click();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themeMode === 'system') applyTheme(); });

/* --------------------------------------------------------------- account */
function connectionKey(cloud) { return cloud?.connected ? `${cloud.clientId || ''}:${cloud.connectionId || ''}` : null; }
function closeAccountMenu({ focus = false } = {}) { $('account-menu').hidden = true; $('account-toggle').setAttribute('aria-expanded', 'false'); if (focus) $('account-toggle').focus(); }
function renderAccount() {
  const account = accountPresentation(connectionBusy ? { ...snapshot?.cloud, profile: null } : snapshot?.cloud);
  $('account-name').textContent = account.name; $('account-detail').textContent = connectionBusy ? 'Connecting…' : account.detail; $('account-avatar').textContent = account.initial;
  $('account-toggle').setAttribute('aria-label', `${account.name}: account and settings`);
  $('account-connect').hidden = account.connected || connectionBusy; $('account-disconnect').hidden = !account.connected && !connectionBusy;
  $('account-connect').disabled = $('connect').disabled = connectionBusy;
  $('account-disconnect').disabled = connectionOperation === 'disconnect';
  $('account-disconnect').textContent = connectionOperation === 'connect' ? 'Cancel sign-in' : 'Disconnect';
  $('connect-hint').hidden = account.connected || connectionBusy;
}
async function loadProfile(key, generation = profileGeneration) {
  try { const profile = await api('/api/profile'); if (!connectionBusy && generation === profileGeneration && connectionKey(snapshot?.cloud) === key) { snapshot.cloud.profile = profile; renderAccount(); } } catch { /* A profile read cannot invent an identity or block a local Journal. */ }
}
function refreshAccountProfile() {
  const key = connectionKey(snapshot?.cloud);
  if (!connectionBusy && key !== profileConnectionKey) { profileConnectionKey = key; if (key !== null) void loadProfile(key); }
}
async function loadAccounts() {
  const key = connectionKey(snapshot?.cloud);
  if (key === accountsKey) return;
  accountsKey = key; accounts = [];
  if (key) { try { accounts = (await api('/api/accounts')).accounts; } catch { accounts = []; accountsKey = null; } }
  renderAccountChoice();
}
function renderAccountChoice(current = $('account').value || snapshot?.settings.accountId || '') {
  const options = accounts.map(row => [row.id, row.displayName || row.publicId]);
  const prompt = snapshot?.cloud.connected ? (accounts.length ? 'Choose an account' : 'No accounts found') : 'Connect Flusso first';
  if (changed('account-options', [prompt, options])) $('account').replaceChildren(new Option(prompt, ''), ...options.map(([id, label]) => new Option(label, id)));
  $('account').value = accounts.some(row => row.id === current) ? current : '';
  $('account').disabled = !accounts.length;
  if (snapshot) renderWatchSummary();
}

/* --------------------------------------------------------------- desktop */
function renderProgress(prefix, visible, percent) {
  $(`${prefix}-progress-wrap`).hidden = !visible;
  if (percent === null) $(`${prefix}-progress`).removeAttribute('value'); else $(`${prefix}-progress`).value = percent;
  $(`${prefix}-progress-label`).textContent = percent === null ? '' : formatPercentLabel(percent);
}
function renderDesktop() {
  if (!desktop) return;
  $('native-controls').hidden = false; $('model-manual-command').hidden = true;
  if (!desktopStatus) return;
  const update = updatePresentation(desktopStatus.update ?? {}), model = modelPresentation(desktopStatus.model ?? {});
  $('app-version').textContent = desktopStatus.version || '—';
  $('app-mode').textContent = desktopStatus.packaged ? 'Flusso Journal' : 'Development build';
  $('start-on-login').checked = desktopStatus.startOnLogin === true; $('start-on-login').disabled = desktopStatus.startOnLoginSupported === false || nativeTasks.has('setStartOnLogin');
  $('start-on-login').closest('label').title = desktopStatus.startOnLoginSupported === false ? 'Use your Linux desktop’s startup settings.' : '';
  $('check-updates').disabled = update.busy || update.state === 'unsupported' || nativeTasks.has('checkUpdates');
  $('app-update-status').textContent = update.message || (update.state === 'current' ? update.label : '');
  $('update-corner').hidden = !update.visible || dismissedUpdate === `${update.state}:${update.version}`;
  $('update-title').textContent = ({ available: 'Update available', checking: 'Checking for updates', downloading: 'Downloading update', downloaded: 'Ready to install', error: 'Update failed' })[update.state] || 'Update';
  $('update-detail').replaceChildren();
  if (update.version) $('update-detail').append(element('span', `v${update.version}`, 'mono'), document.createTextNode(' · '));
  $('update-detail').append(document.createTextNode(update.message || (update.state === 'downloaded' ? 'Restart to finish.' : update.state === 'available' ? 'Downloads in the background.' : update.label)));
  $('update-action').textContent = update.label; $('update-action').disabled = !update.action || nativeTasks.has(update.action);
  renderProgress('update', update.state === 'downloading', update.percent);
  $('model-setup').hidden = !model.visible; setText('model-setup-title', model.title);
  if (model.message || model.busy) $('model-setup-status').textContent = model.message || 'Downloading the model. You can keep writing.';
  $('model-state').textContent = model.message || (desktopStatus.model?.state === 'ready' ? 'Qwen3 1.7B is ready. It runs on this computer.' : model.label);
  for (const id of ['setup-model', 'setup-model-panel']) { $(id).textContent = model.busy ? 'Setting up…' : model.state === 'error' ? 'Retry' : 'Set up'; $(id).disabled = model.busy || nativeTasks.has('setupModel'); }
  $('setup-model-panel').hidden = !model.visible;
  renderProgress('model', model.busy && model.visible, model.percent);
}
async function nativeAction(method, argument) {
  if (!desktop || nativeTasks.has(method)) return;
  nativeTasks.add(method); renderDesktop();
  try { await desktop[method](argument); desktopStatus = await desktop.status(); }
  catch (error) { notify(error.message || 'That did not work. Try again.', false, true); }
  finally { nativeTasks.delete(method); renderDesktop(); }
}
async function initializeDesktop() {
  if (!desktop) return;
  updateDraftProtection();
  const unsubscribe = desktop.onStatus(status => { desktopStatus = status; renderDesktop(); });
  window.addEventListener('pagehide', () => unsubscribe(), { once: true });
  desktopStatus = await desktop.status(); renderDesktop();
}
$('account-toggle').addEventListener('click', () => { const open = $('account-menu').hidden; $('account-menu').hidden = !open; $('account-toggle').setAttribute('aria-expanded', String(open)); });
document.addEventListener('click', event => { if (!$('account-area').contains(event.target)) closeAccountMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('account-menu').hidden) closeAccountMenu({ focus: true }); });
$('account-settings').addEventListener('click', event => { if (desktop) { event.preventDefault(); nativeAction('openAccountSettings'); } closeAccountMenu(); });
$('start-on-login').addEventListener('change', event => nativeAction('setStartOnLogin', event.currentTarget.checked));
$('check-updates').addEventListener('click', () => { dismissedUpdate = null; nativeAction('checkUpdates'); });
$('dismiss-update').addEventListener('click', () => { const update = updatePresentation(desktopStatus?.update ?? {}); dismissedUpdate = `${update.state}:${update.version}`; renderDesktop(); });
$('update-action').addEventListener('click', () => { const update = updatePresentation(desktopStatus?.update ?? {}); if (update.action) nativeAction(update.action); });
for (const id of ['setup-model', 'setup-model-panel']) $(id).addEventListener('click', () => nativeAction('setupModel'));

/* ----------------------------------------------------------------- views */
function switchView(view) {
  if (entrySaving && view !== 'journal') { notify('This entry is still saving. Wait for the result before leaving it.'); return; }
  // A new page opens at its top; returning to the same page keeps the reader's place.
  if ($(`view-${view}`).hidden) window.scrollTo({ top: 0 });
  document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== `view-${view}`; });
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (view === 'listener') loadAccounts();
  if (view === 'journal' && !selected && snapshot?.entries.length) { selected = snapshot.entries[0]; renderEntries(); renderDetail(); }
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));

async function load({ forms = false } = {}) {
  const next = await api('/api/status');
  if ((snapshot?.listener.sequence ?? 0) > (next.listener.sequence ?? 0)) next.listener = snapshot.listener;
  snapshot = next;
  if (snapshot.display?.theme && snapshot.display.theme !== themeMode) applyTheme(snapshot.display.theme);
  renderAccount(); renderDesktop(); refreshAccountProfile();
  if (connectionKey(snapshot.cloud) !== accountsKey && !$('view-listener').hidden) loadAccounts();
  renderStatus();
  $('journal-coverage').textContent = snapshot.limits?.entries ? `Showing up to ${formatCount(snapshot.limits.entries)} recent entries.` : 'Showing the loaded entries.';
  $('activity-coverage').textContent = snapshot.limits?.activity ? `Latest completed research and unfinished check per revision, plus receipts. Showing up to ${formatCount(snapshot.limits.activity)} saved rows and the last completed response; unconfirmed results stay first.` : 'Recent decisions and order receipts. Unconfirmed results stay on top.';
  if (!desktop) $('model-state').textContent = snapshot.model.installed ? 'Qwen3 1.7B is ready through Ollama.' : snapshot.model.available ? 'Ollama is running. Download the model:' : 'Start Ollama, then download the model:';
  $('sync').disabled = !snapshot.cloud.connected;
  const notebookOptions = snapshot.notebooks.map(row => [row.origin, row.id, row.name]);
  if (changed('journal-notebook-options', notebookOptions)) {
    const selectedFilter = $('journal-filter').value;
    $('journal-filter').replaceChildren(new Option('All notebooks', ''), ...notebookOptions.map(([origin, id, name]) => new Option(origin === 'cloud' ? `${name} · cloud` : name, `${origin}:${id}`)));
    $('journal-filter').value = selectedFilter;
  }
  if (changed('entries', [snapshot.entries, notebookOptions])) renderEntries();
  renderActivity();
  renderProcess(); renderDecisions();
  if (forms || !formDirty) fillSettings();
  recoverPollNotice();
}
function renderStatus() {
  const { settings, listener } = snapshot;
  const tone = streamDisconnected ? 'warn' : !settings.enabled ? '' : listener.lastError ? 'warn' : 'on';
  $('listener-dot').className = `nav-dot ${tone}${!streamDisconnected && settings.enabled && listener.busy ? ' busy' : ''}`;
  $('listener-dot-label').textContent = streamDisconnected ? 'Reconnecting' : !settings.enabled ? 'Off' : listener.lastError ? 'Needs attention' : listener.busy ? 'Reading' : 'On';
  // The schedule lives here; the review desk owns state, errors and the next action.
  const interval = intervalLabel(settings.intervalSeconds), parts = [];
  const lastCheck = listener.lastCheckedAtUtc ? `Last checked ${when(listener.lastCheckedAtUtc, true)}` : listener.modelReview?.startedAtUtc ? `Last review recorded ${when(listener.modelReview.startedAtUtc, true)} · check completion unavailable` : 'Not checked yet';
  if (!settings.enabled) parts.push(lastCheck);
  else {
    if (interval) parts.push(`Checks ${interval} after the previous check finishes`);
    parts.push(lastCheck);
    if (listener.cloudComplete === false) parts.push('Cloud read incomplete');
  }
  setText('last-check', parts.join(' · '));
  $('last-check').classList.toggle('warn', Boolean(settings.enabled && listener.cloudComplete === false));
  const pending = snapshot.attempts.filter(row => ['pending', 'unknown'].includes(row.status)).length;
  $('activity-count').hidden = !pending; $('activity-count').textContent = formatCount(pending);
  $('activity-count').closest('button').setAttribute('aria-label', pending ? `Activity, ${formatCount(pending)} unconfirmed` : 'Activity');
  $('check-now').disabled = !settings.enabled || Boolean(listener.busy);
  $('check-now').classList.toggle('primary', settings.enabled && !listener.busy);
  $('check-now').title = !settings.enabled ? 'Turn Listener on to check notes' : streamDisconnected && listener.busy ? 'Waiting for current status. The last reported check may still be running.' : listener.busy ? 'A check is already running' : 'Review the newest selected note';
  $('check-now').textContent = listener.busy ? streamDisconnected ? 'Status unavailable' : 'Checking…' : 'Check now';
  renderWatchSummary();
}

function renderWatchSummary() {
  const { settings, notebooks } = snapshot;
  const names = notebooks.filter(row => settings.notebookIds.includes(row.id)).map(row => row.name);
  const account = accounts.find(row => row.id === settings.accountId);
  const item = (term, value, state) => { const row = element('div', null, 'watch-item'); if (state) row.dataset.state = state; const detail = element('dd', value); detail.title = value; row.append(element('dt', term), detail); return row; };
  const next = [
    ['Watching', names.length ? names.join(', ') : 'All notebooks'],
    ['Auto-trade', settings.executionEnabled ? 'On' : 'Off', settings.executionEnabled ? 'on' : ''],
    ['Account', account ? account.displayName || account.publicId : settings.accountId ? 'Selected' : 'None'],
  ];
  if (!changed('watch-summary', next)) return;
  $('watch-summary').replaceChildren(...next.map(row => item(...row)));
}

function configureListener(open) {
  $('listener-configuration').hidden = !open;
  $('configure-listener').setAttribute('aria-expanded', String(open));
  if (open) { reveal($('listener-configuration'), 'nearest'); $('close-configuration').focus({ preventScroll: true }); }
  else $('configure-listener').focus();
}
$('listener-configuration').addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); configureListener(false); } });
$('configure-listener').addEventListener('click', () => configureListener($('listener-configuration').hidden));
$('close-configuration').addEventListener('click', () => configureListener(false));
$('all-activity').addEventListener('click', () => switchView('activity'));

function sourceButton(row, label = row.title || 'Open Journal entry') {
  const entry = snapshot.entries.find(item => item.id === row.entryId && (!row.origin || row.origin === item.origin));
  if (!entry) return element('span', label);
  const button = element('button', label, 'source-link'); button.type = 'button';
  button.dataset.rowControl = 'source';
  button.addEventListener('click', () => { const current = snapshot.entries.find(item => item.id === row.entryId && (!row.origin || row.origin === item.origin)); if (current) openEntry(current); });
  return button;
}
function openEntry(entry) {
  switchView('journal'); if (!leaveEditor()) return;
  selected = entry; showSelectedEntry(); renderEntries();
  reveal($('entry-detail'), 'start'); $('entry-detail').focus({ preventScroll: true });
}

// The raw response stays one click away whenever its reason is shown as prose.
let rawOpen = false;
$('model-raw-toggle').addEventListener('click', () => { rawOpen = !rawOpen; renderProcess(); if (rawOpen) $('model-output').focus(); });

// Appends only what arrived, and follows new text only while the reader is already
// at the end of it. Scrolling up to read holds the position; the page never moves.
function renderOutputText(output) {
  const node = $('model-output'), text = output?.text ?? '', key = output ? `${output.origin}:${output.entryId}:${output.atUtc}` : '';
  if (node.dataset.key !== key) { node.dataset.key = key; node.textContent = text; node.scrollTop = 0; return; }
  const current = node.textContent;
  if (text === current) return;
  const following = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  if (current && text.startsWith(current)) node.append(text.slice(current.length)); else node.textContent = text;
  if (following) node.scrollTop = node.scrollHeight;
}
// Streamed words are appended, so a reader's selection survives the next token.
function growText(node, value) {
  const current = node.textContent;
  if (value === current) return;
  if (current && value.startsWith(current)) node.append(value.slice(current.length)); else node.textContent = value;
}

let lastCompletionKey = null, completionFrame = null;
function renderReviewFocus(id, focus, prepared = false) {
  const view = reviewFocusPresentation(focus, { prepared });
  setText(`${id}-summary`, view.label); setText(`${id}-text`, view.text);
}
function positionResponseTools(accepted) {
  const tools = $('model-response-tools'), verdict = $('model-verdict');
  const positioned = accepted ? verdict.nextElementSibling === tools : tools.nextElementSibling === verdict;
  if (positioned) return;
  const focused = document.activeElement, restore = tools.contains(focused);
  if (accepted) verdict.after(tools); else verdict.before(tools);
  if (restore && document.activeElement !== focused) focused.focus();
}
function renderProcess() {
  const { listener, settings } = snapshot, output = listener.modelOutput;
  const state = processingPresentation(listener, settings.enabled, { disconnected: streamDisconnected });
  const view = modelOutputPresentation(output, listener.lastModelOutput, { disconnected: streamDisconnected, enabled: settings.enabled, busy: listener.busy });
  const completed = completedModelPresentation(listener, snapshot.entries);
  const earlier = listener.modelReview?.id != null && output?.checkId !== listener.modelReview.id;
  const desk = $('review-desk');
  desk.dataset.state = state.state; desk.dataset.live = String(view.live);
  setText('process-state', state.title);
  const stage = state.busy ? `${state.label}${state.position ? ` · ${formatCount(state.position.index)} of ${formatCount(state.position.total)}` : ''}` : '';
  setText('process-stage', stage); $('process-stage').hidden = !stage;
  setText('process-message', state.message);

  $('output-frame').dataset.status = view.status;
  setText('model-output-heading', !settings.enabled && output ? 'Last model response' : 'Model output');
  setText('model-output-status', earlier && output ? 'Earlier response' : !settings.enabled && view.status === 'complete' ? 'Last check complete' : view.label); $('model-output-status').className = `output-status ${!settings.enabled && view.status === 'complete' ? '' : view.tone}`;
  $('model-output-status').hidden = !output && Boolean(completed) || settings.enabled && view.accepted && !earlier || view.live || view.status === 'failed' && state.title === view.label && Boolean(listener.lastError);
  if (changed('model-output-source', output ? [output.entryId, output.origin, output.title, output.atUtc, snapshot.entries.some(row => row.id === output.entryId && row.origin === output.origin)] : null)) {
    const source = $('model-output-source');
    if (output) { const time = element('time', `Check started ${when(output.atUtc, true)}`); time.dateTime = output.atUtc; source.replaceChildren(element('span', 'Source note', 'hint'), sourceButton(output, output.title || 'Journal entry'), time); }
    else source.replaceChildren();
  }
  // A new stream has its own draft. The last completed reason remains readable
  // in the same DOM node, labelled with its own source, revision and completion.
  const draft = view.draft !== null;
  setText('model-input-coverage', output ? modelCoverageLabel(output.coverage, { received: Boolean(output.text) || view.accepted }) : '');
  $('model-input-coverage').hidden = !output || view.accepted;
  $('model-input-focus').hidden = !output || view.accepted;
  if (output) renderReviewFocus('model-input-focus', output.focus, !output.text && !view.accepted);
  const announcement = listener.busy || earlier && !listener.lastError ? null : completionAnnouncement(view, output, lastCompletionKey, listener.lastError);
  if (listener.busy || (!view.accepted && !['failed', 'stopped'].includes(view.status) && !listener.lastError)) {
    cancelAnimationFrame(completionFrame); setText('model-completion', '');
  } else if (announcement) {
    lastCompletionKey = announcement.key;
    // A changed reason may keep the same short label. Separate the update from
    // clearing it so the live region can announce that real change as well.
    setText('model-completion', '');
    cancelAnimationFrame(completionFrame);
    completionFrame = requestAnimationFrame(() => { if (lastCompletionKey === announcement.key) setText('model-completion', announcement.message); });
  }
  if ((draft || view.accepted) && output?.text && $('model-output').contains(document.activeElement)) rawOpen = true;
  const rawHidden = !output?.text || ((draft || view.accepted) && !rawOpen);
  // Scheduled checks may hide the current raw answer/draft. Browser scrolling
  // must expose the visible focus target, rather than leave it above the viewport.
  if ((rawHidden && $('model-output').contains(document.activeElement))
    || (!draft && $('model-draft').contains(document.activeElement))
    || (!completed && $('model-verdict').contains(document.activeElement))
    || (!output?.text && document.activeElement === $('model-raw-toggle'))) $('process-state').focus();
  $('model-draft').hidden = !draft;
  $('model-draft-head').className = view.live ? 'sr-only' : 'verdict-head';
  if (draft) {
    setText('model-draft-kicker', view.live ? 'Format check pending' : view.draftLabel);
    setText('model-draft-label', view.live ? 'Live model response' : 'Response not accepted');
    growText($('model-draft-reason'), view.draft);
  }
  $('model-verdict').hidden = !completed;
  if (completed) {
    $('model-verdict').dataset.state = 'accepted';
    setText('model-verdict-kicker', `${completed.earlier ? 'Earlier local' : 'Local'} model response · format checked`);
    setText('model-verdict-label', completed.label.charAt(0).toUpperCase() + completed.label.slice(1));
    $('model-verdict-label').className = `verdict-label ${completed.tone}`;
    growText($('model-verdict-reason'), completed.reason);
    setText('model-verdict-context', completed.context);
    setText('model-verdict-coverage', modelCoverageLabel(completed.output.coverage, { received: true }));
    renderReviewFocus('model-verdict-focus', completed.output.focus);
    const source = completed.output;
    const metadata = $('model-verdict-source');
    if (changed('model-verdict-source', [source.entryId, source.origin, source.title, snapshot.entries.some(row => row.id === source.entryId && row.origin === source.origin)])) {
      if (metadata.contains(document.activeElement)) $('model-verdict-label').focus();
      metadata.replaceChildren(element('span', 'Source note', 'hint'), sourceButton(source, source.title || 'Journal entry'), element('time'));
    }
    const time = metadata.querySelector('time'); interfaceText(time, `${source.completionKnown === false ? 'Recorded' : 'Completed'} ${when(source.atUtc, true)}`); time.dateTime = source.atUtc;
  }
  const sourceHidden = !output || view.accepted;
  if (sourceHidden && $('model-output-source').contains(document.activeElement)) $('model-verdict-label').focus();
  $('model-output-source').hidden = sourceHidden;
  setText('model-raw-toggle', rawOpen ? 'Hide raw response' : 'Show raw response');
  $('model-raw-toggle').setAttribute('aria-expanded', String(rawOpen)); $('model-raw-toggle').hidden = !output?.text || !(draft || view.accepted);
  renderOutputText(output);
  $('model-output').hidden = rawHidden;
  setText('model-output-note', view.note ?? ''); $('model-output-note').hidden = !view.note;
  setText('model-output-empty', view.empty ?? ''); $('model-output-empty').hidden = !view.empty || Boolean(completed) && !listener.busy;
  $('model-response-tools').hidden = $('model-raw-toggle').hidden && rawHidden && !view.note;
  positionResponseTools(view.accepted);

  const events = (listener.events ?? []).slice(-30);
  const items = decisionItems(events, () => ({}));
  if (!changed('process-events', items)) return;
  const list = $('process-events'), atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  reconcileRows(list, items, ({ row }) => {
    const item = element('li', null, `process-event${row.stage === 'error' ? ' warn' : ''}`), time = element('time', timeOf(row.atUtc)); time.dateTime = row.atUtc;
    const head = element('div', null, 'event-head'), body = element('div', null, 'event-body');
    head.append(element('span', processStage(row.stage), 'event-stage'), time);
    if (row.title) body.append(sourceButton(row));
    if (row.message) body.append(element('p', row.message));
    item.append(head, body); return item;
  });
  list.hidden = !events.length; $('process-events-empty').hidden = Boolean(events.length);
  setText('process-count', events.length ? `Latest ${formatCount(events.length)} update${events.length === 1 ? '' : 's'}` : '');
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function renderDecisions() {
  const output = snapshot.listener.modelOutput, published = snapshot.listener.lastModelOutput;
  const all = latestDecisions(snapshot.activity, published, { limit: null });
  const completed = Boolean(completedModelPresentation(snapshot.listener, snapshot.entries));
  const failure = snapshot.listener.lastError && snapshot.listener.modelReview?.status === 'failed' ? { checkId: snapshot.listener.modelReview.id, reason: snapshot.listener.lastError } : null;
  const latest = all.filter(row => !decisionShownInDesk(row, output, published, { completed, failure })).slice(0, 5);
  const panel = $('latest-decisions').closest('section'), hidden = all.length > 0 && !latest.length;
  if (hidden && panel.contains(document.activeElement)) $('model-verdict-label').focus();
  panel.hidden = hidden;
  const items = decisionItems(latest, row => {
    const source = snapshot.entries.find(entry => entry.id === row.entryId && entry.origin === row.origin);
    return { enabled: snapshot.settings.enabled, ...activityMetadata(row, source) };
  });
  if (!changed('decisions', items)) return;
  reconcileRows($('latest-decisions'), items.length ? items : [{ key: 'empty', value: null }], value => {
    if (!value) return element('p', 'No decisions yet. Local model responses and order results appear here after a check.', 'empty');
    const { row, enabled, revision, clock, clockLabel, historical } = value;
    const item = element('article', null, 'decision-row'), top = element('div', null, 'decision-top'), source = element('div', null, 'decision-source'), status = activityStatus(row, { historical });
    const time = element('time', `${clockLabel} ${when(clock, true)}`); time.dateTime = clock;
    top.append(pill(status.label, status.tone), element('span', revision, 'hint mono'), time); source.append(sourceButton(row));
    item.append(top, source);
    item.append(element('p', activityReason(row), 'decision-excerpt'));
    if (row.status === 'waiting' && !enabled && !(historical && row.kind === 'research_check')) item.append(element('p', 'Checks resume when you turn the Listener on.', 'hint'));
    return item;
  });
}

/* -------------------------------------------------------------- settings */
function fillSettings() {
  const settings = snapshot.settings, risk = settings.risk ?? {};
  $('enabled').checked = settings.enabled; $('enabled-label').textContent = settings.enabled ? 'On' : 'Turn on';
  $('enabled').setAttribute('aria-label', settings.enabled ? 'Listener on' : 'Turn on Listener');
  $('execution').checked = settings.executionEnabled;
  for (const radio of document.querySelectorAll('input[name=source]')) radio.checked = radio.value === settings.source;
  ensureOption($('interval'), settings.intervalSeconds, intervalLabel(settings.intervalSeconds) ?? 'Unavailable interval'); $('interval').value = String(settings.intervalSeconds);
  ensureOption($('max-age'), settings.maxSignalAgeSeconds, `${formatCount(Math.round(settings.maxSignalAgeSeconds / 60))} minutes`); $('max-age').value = String(settings.maxSignalAgeSeconds);
  $('section').value = settings.section; $('instructions').value = settings.instructions;
  $('max-slippage').value = risk.maxSlippagePct ?? ''; $('max-order').value = risk.maxOrderUsd ?? ''; $('min-volume').value = risk.minVolume24hUsd ?? '';
  $('max-tickets').value = settings.maxTicketsPerDay ?? 24; $('max-ticket').value = risk.maxTicketUsd ?? ''; $('max-leverage').value = risk.maxLeverage ?? '';
  $('together').checked = risk.together !== false;
  $('write-back').checked = settings.writeBack !== false;
  if (changed('watch-notebook-options', snapshot.notebooks.map(row => [row.id, row.origin, row.name]))) {
    $('watch-notebooks').replaceChildren(...snapshot.notebooks.map(row => {
      const label = element('label'), input = element('input'), chip = element('span', row.name);
      input.type = 'checkbox'; input.value = row.id;
      if (row.origin === 'cloud') chip.append(element('small', 'cloud'));
      label.append(input, chip); return label;
    }));
    if (!snapshot.notebooks.length) $('watch-notebooks').append(element('span', 'No notebooks yet.', 'hint'));
  }
  for (const input of $('watch-notebooks').querySelectorAll('input')) input.checked = settings.notebookIds.includes(input.value);
  renderAccountChoice(settings.accountId ?? '');
  renderRiskValidation();
  formDirty = false; $('execution-draft-warning').hidden = true; setText('configure-label', 'Configure'); $('settings-draft-hint').hidden = true; $('save-settings').disabled = true; $('save-settings').textContent = 'Saved';
}
const requiredRiskFields = { 'max-order': 'Set a maximum USD amount per order.', 'max-ticket': 'Set a maximum USD amount per ticket.', 'max-leverage': 'Set a maximum leverage.' };
function renderRiskValidation() {
  let firstInvalid = null;
  for (const [id, missingMessage] of Object.entries(requiredRiskFields)) {
    const input = $(id), message = $(`${id}-error`);
    input.placeholder = 'Required';
    input.required = snapshot.settings.executionEnabled;
    let error = '';
    if (riskValidationActive) {
      input.required = true;
      if (!input.validity.valid) { error = input.validity.valueMissing ? missingMessage : input.validationMessage; firstInvalid ??= input; }
      input.required = snapshot.settings.executionEnabled;
    }
    input.setAttribute('aria-invalid', String(Boolean(error)));
    const descriptions = [error ? message.id : null, input.id === 'max-leverage' ? 'max-leverage-scope' : null].filter(Boolean);
    if (descriptions.length) input.setAttribute('aria-describedby', descriptions.join(' ')); else input.removeAttribute('aria-describedby');
    message.textContent = error; message.hidden = !error;
  }
  return firstInvalid;
}
function ensureOption(select, value, label) { if (![...select.options].some(option => option.value === String(value))) select.append(new Option(label, String(value))); }
function amount(id) { const raw = $(id).value.trim(); if (!raw) return null; const value = Number(raw); if (!Number.isFinite(value) || value <= 0) throw new Error('Limits must be positive numbers, or left blank.'); return value; }
function settingsBody(overrides = {}) {
  return {
    version: snapshot.settings.version, enabled: $('enabled').checked, executionEnabled: $('execution').checked,
    source: document.querySelector('input[name=source]:checked')?.value ?? 'local',
    notebookIds: [...$('watch-notebooks').querySelectorAll('input:checked')].map(input => input.value),
    section: $('section').value, instructions: $('instructions').value, intervalSeconds: Number($('interval').value),
    maxSignalAgeSeconds: Number($('max-age').value), maxTicketsPerDay: Number($('max-tickets').value), writeBack: $('write-back').checked, accountId: $('account').value || null,
    risk: { maxSlippagePct: amount('max-slippage'), maxOrderUsd: amount('max-order'), maxTicketUsd: amount('max-ticket'), maxLeverage: amount('max-leverage'), minVolume24hUsd: amount('min-volume'), together: $('together').checked },
    ...overrides,
  };
}
async function saveSettings(message, body = settingsBody(), { forms = true } = {}) {
  const edit = settingsEdit;
  try { snapshot.settings = await api('/api/settings', body); }
  catch (error) { await load().catch(() => {}); throw error; }
  // A successful write stays successful even if the follow-up read is offline.
  // Edits typed during that request remain a draft rather than being replaced.
  if (forms && edit === settingsEdit) fillSettings();
  try { await load(); }
  catch { renderStatus(); renderProcess(); notify(`${message} Settings saved, but the view could not refresh. Refresh to check the latest activity.`, false, true); return; }
  notify(message, true);
}
$('settings-form').addEventListener('input', () => { formDirty = true; settingsEdit += 1; setText('configure-label', 'Configure · Unsaved'); $('settings-draft-hint').hidden = !$('execution-draft-warning').hidden; $('save-settings').disabled = false; $('save-settings').textContent = 'Save'; if (riskValidationActive) renderRiskValidation(); });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); await action(event.submitter, () => saveSettings('Saved.'));
  $('save-settings').disabled = !formDirty;
});
// Immediate switches use saved settings only; an unsaved risk draft is never
// silently applied or discarded. Off remains available even with a dirty form.
async function saveSwitch(id, field, message) {
  const value = $(id).checked;
  const savedMessage = formDirty ? `${message} Using saved settings; your edits are still unsaved.` : message;
  if (field === 'executionEnabled' && value) {
    riskValidationActive = true;
    const invalid = renderRiskValidation();
    if (invalid) {
      $(id).checked = snapshot.settings.executionEnabled;
      configureListener(true); reveal(invalid, 'center'); invalid.focus({ preventScroll: true }); return;
    }
  }
  if (field === 'executionEnabled' && value && formDirty) {
    $(id).checked = snapshot.settings.executionEnabled;
    $('execution-draft-warning').hidden = false; $('settings-draft-hint').hidden = true; $('notice').hidden = true; return;
  }
  $('enabled').disabled = $('execution').disabled = true;
  try { await saveSettings(savedMessage, settingsSwitchBody(snapshot.settings, field, value), { forms: false }); }
  finally {
    $('enabled').checked = snapshot.settings.enabled;
    $('enabled-label').textContent = snapshot.settings.enabled ? 'On' : 'Turn on';
    $('enabled').setAttribute('aria-label', snapshot.settings.enabled ? 'Listener on' : 'Turn on Listener');
    $('execution').checked = snapshot.settings.executionEnabled;
    $('enabled').disabled = $('execution').disabled = false;
    renderRiskValidation();
    renderStatus(); renderProcess();
  }
}
$('enabled').addEventListener('change', event => { event.stopPropagation(); action(null, () => saveSwitch('enabled', 'enabled', $('enabled').checked ? 'Listener on. The newest selected research note will be reviewed each period.' : 'Listener off.')); });
$('execution').addEventListener('change', event => { event.stopPropagation(); action(null, () => saveSwitch('execution', 'executionEnabled', $('execution').checked ? 'Auto-trade on.' : 'Auto-trade off.')); });
$('enabled').addEventListener('input', event => event.stopPropagation());
$('execution').addEventListener('input', event => event.stopPropagation());
$('check-now').addEventListener('click', async event => {
  await action(event.currentTarget, async () => {
    if (!snapshot.settings.enabled) { notify('Turn the Listener on first.'); return; }
    await api('/api/check', {}); await load();
  });
  // A check can finish after the owner switches off. Restore that current state
  // after the shared action helper releases its temporary button lock.
  renderStatus();
});
for (const id of ['ticket-example', 'editor-ticket-example']) $(id).textContent = JSON.stringify(TICKET_EXAMPLE, null, 2);

/* --------------------------------------------------------------- journal */
// Opening a source or saving a note must reveal it even under an excluding filter.
function showSelectedEntry() {
  if (!selected) return;
  if ($('journal-filter').value && $('journal-filter').value !== `${selected.origin}:${selected.notebookId}`) $('journal-filter').value = '';
  if (!matchesResultFilter(selected, $('result-filter').value)) $('result-filter').value = '';
}
function renderEntries() {
  const filter = $('journal-filter').value, result = $('result-filter').value;
  const rows = snapshot.entries.filter(row => (!filter || `${row.origin}:${row.notebookId}` === filter) && matchesResultFilter(row, result));
  if (selected) selected = rows.find(row => row.id === selected.id && row.origin === selected.origin) ?? null;
  const items = rows.map(row => ({ key: `${row.origin}:${row.id}`, value: entryCardPresentation(row, { book: notebookName(row), time: when(row.updatedAtUtc), selected: selected?.id === row.id && selected.origin === row.origin }) }));
  if (!items.length) items.push({ key: 'empty', value: { empty: true, hasEntries: Boolean(snapshot.entries.length) } });
  reconcileRows($('entry-list'), items, row => {
    if (row.empty) {
      const empty = element('div', null, 'empty list-empty');
      const button = element('button', row.hasEntries ? 'Show all entries' : 'Write the first entry', 'link-button'); button.type = 'button';
      button.addEventListener('click', () => { if (row.hasEntries) { $('journal-filter').value = ''; $('result-filter').value = ''; renderEntries(); } else showEditor(); });
      empty.append(element('p', row.hasEntries ? 'No entries match these filters.' : 'Your Journal is empty.'), button);
      return empty;
    }
    const button = element('button', null, 'entry-card'); button.type = 'button';
    button.classList.toggle('selected', row.selected); if (row.selected) button.setAttribute('aria-current', 'true');
    const meta = element('span', null, 'meta');
    meta.append(element('time', row.time));
    if (row.book) meta.append(element('span', row.book, 'meta-book'));
    const tags = element('span', null, 'tags');
    tags.append(element('span', row.status, `entry-state ${row.status}`));
    if (row.check) tags.append(pill(row.check.label, row.check.tone));
    if (row.outcome) tags.append(pill(row.outcome.label, row.outcome.tone));
    if (row.origin === 'cloud') tags.append(pill('cloud'));
    button.append(element('strong', row.title), meta, tags);
    button.addEventListener('click', () => { const current = snapshot.entries.find(item => item.id === row.id && item.origin === row.origin); if (current) openEntry(current); }); return button;
  });
  if (selected) { const current = snapshot.entries.find(row => row.id === selected.id && row.origin === selected.origin); if (current) { selected = current; renderDetail(); } }
  else renderDetail();
}
function notebookName(row) { return snapshot.notebooks.find(book => book.id === row.notebookId && book.origin === row.origin)?.name ?? ''; }
function receiptDetailsCell(line) {
  const cell = element('td', null, 'wrap'), details = receiptDetails(line);
  cell.append(document.createTextNode(details.message));
  if (details.riskCode) cell.append(document.createTextNode(details.message ? ' · ' : ''), element('code', details.riskCode));
  return cell;
}
function ordersTable(orders, withResults = false) {
  const wrap = element('div', null, 'table-scroll'), table = element('table'), thead = element('thead'), head = element('tr'), tbody = element('tbody');
  const columns = withResults ? ['Instrument', 'Side', 'Qty', 'Limit', 'Result', 'Order ID', 'Details'] : ['Instrument', 'Side', 'Qty', 'Limit', 'Max slip', 'Max USD'];
  columns.forEach((label, index) => head.append(element('th', label, index >= 2 && index <= 3 || (!withResults && index >= 4) ? 'num' : '')));
  thead.append(head); table.append(thead);
  for (const order of orders) {
    const tr = element('tr');
    tr.append(element('td', order.instrumentId, 'mono'), element('td', order.side), element('td', formatQuantity(order.quantity), 'num'), element('td', formatPrice(order.limitPrice), 'num'));
    if (withResults) { const status = element('td'), result = activityStatus(order); status.append(pill(result.label, result.tone)); tr.append(status, element('td', order.orderId || '—', 'mono'), receiptDetailsCell(order)); }
    else tr.append(element('td', order.conditions?.maxSlippagePct != null ? formatPercent(order.conditions.maxSlippagePct) : '—', 'num'), element('td', order.conditions?.maxNotionalUsd != null ? formatMoney(order.conditions.maxNotionalUsd) : '—', 'num'));
    tbody.append(tr);
  }
  table.append(tbody); wrap.append(table); return wrap;
}
function positionsTable(positions, withResults = false) {
  const wrap = element('div', null, 'table-scroll'), table = element('table'), thead = element('thead'), head = element('tr'), tbody = element('tbody');
  for (const label of withResults ? ['Position', 'Result', 'Details'] : ['Position to close']) head.append(element('th', label));
  thead.append(head); table.append(thead);
  for (const row of positions) {
    const position = typeof row === 'string' ? { positionId: row } : row, tr = element('tr'); tr.append(element('td', position.positionId, 'mono'));
    if (withResults) { const status = element('td'), result = activityStatus(position); status.append(pill(result.label, result.tone)); tr.append(status, receiptDetailsCell(position)); }
    tbody.append(tr);
  }
  table.append(tbody); wrap.append(table); return wrap;
}
function renderDetail() {
  const detail = $('entry-detail'), editFocused = detail.querySelector('[data-entry-action]') === document.activeElement;
  if (!selected) {
    if (!changed('entry-detail:core', { empty: true, hasEntries: Boolean(snapshot?.entries.length) })) return;
    detail.setAttribute('aria-label', 'Selected entry');
    const empty = element('div', null, 'empty-art'), mark = element('img'); mark.src = '/flusso-mark.png'; mark.alt = ''; mark.width = mark.height = 40;
    const write = element('button', snapshot?.entries.length ? 'New entry' : 'Write the first entry'); write.type = 'button';
    write.addEventListener('click', () => showEditor());
    empty.append(mark, element('p', snapshot?.entries.length ? 'Pick an entry to read it, or write a new one.' : 'Write research, questions or an explicit order ticket. Notes stay on this computer unless you copy them.'), write);
    detail.replaceChildren(empty); if (editFocused) write.focus({ preventScroll: true }); return;
  }
  const row = selected, book = notebookName(row);
  if (changed('entry-detail:core', entryReadingCore(row, book))) {
    detail.setAttribute('aria-label', row.title);
    const head = element('header', null, 'detail-head'), heading = element('div', null, 'detail-title');
    const meta = element('div', null, 'detail-meta'), ticketKind = element('span'); ticketKind.dataset.entryPart = 'ticket-kind';
    meta.append(pill(row.status, row.status === 'watching' ? 'info' : ''), ticketKind);
    const facts = element('span', null, 'detail-facts'), time = element('time', when(row.updatedAtUtc)); time.dateTime = row.updatedAtUtc ?? '';
    facts.append(element('span', `${book ? `${book} · ` : ''}${row.origin} · v${formatCount(row.version)} · `, 'interface-numbers'), time); meta.append(facts);
    heading.append(element('h2', row.title), meta);
    const actions = element('div', null, 'detail-actions'), button = element('button', row.origin === 'local' ? 'Edit' : 'Copy to local'); button.type = 'button'; button.dataset.entryAction = 'edit';
    button.addEventListener('click', () => { const current = snapshot.entries.find(item => item.id === row.id && item.origin === row.origin); if (current) showEditor(current.origin === 'local' ? current : { ...current, id: null, version: null }); }); actions.append(button); head.append(heading, actions);
    const prose = element('div', null, 'note-body'); renderMarkdown(prose, (row.body || '').replace(TICKET_FENCE, '').trim() || ' ');
    const live = element('div'); live.dataset.entryPart = 'live';
    const check = element('div'); check.dataset.entryPart = 'check'; detail.replaceChildren(head, prose, check, live);
    if (row.signal) {
      const section = element('section', null, 'detail-section'), quality = row.signal.quality;
      section.append(element('h3', 'Structured signal'), element('p', `${quality ? quality[0].toUpperCase() + quality.slice(1) : 'Unavailable'} · ${row.signal.sourceOperationId} · ${row.signal.sourceAsOfUtc ? when(row.signal.sourceAsOfUtc) : 'no source time'}`, 'hint mono'), element('p', 'Recorded source quality; not a current venue reading.', 'hint'));
      const wrap = element('div', null, 'table-scroll'), table = element('table'), thead = element('thead'), head = element('tr'), tbody = element('tbody');
      ['Instrument', 'Side', 'Direction', 'Qty', 'Unit', 'Ref price'].forEach((label, index) => head.append(element('th', label, index === 3 || index === 5 ? 'num' : '')));
      thead.append(head); table.append(thead);
      for (const leg of row.signal.legs) { const tr = element('tr'); [leg.asset.instrumentId, leg.side ?? '—', leg.direction ?? '—', formatQuantity(leg.quantity), leg.quantityUnit ? `${leg.quantityUnit} ${leg.quantityAsset ?? ''}` : '—', formatPrice(leg.referencePrice)].forEach((value, index) => tr.append(element('td', value, index === 3 || index === 5 ? 'num' : index === 0 ? 'mono' : ''))); tbody.append(tr); }
      table.append(tbody); wrap.append(table); section.append(wrap); detail.append(section);
    }
    renderKeys.delete('entry-detail:kind'); renderKeys.delete('entry-detail:live'); renderKeys.delete('entry-detail:check');
    if (editFocused) button.focus({ preventScroll: true });
  }
  const status = entryStatus(row);
  if (changed('entry-detail:kind', status)) { const slot = detail.querySelector('[data-entry-part="ticket-kind"]'); slot.hidden = !status; slot.replaceChildren(...(status ? [pill(status.label, status.tone)] : [])); }
  if (changed('entry-detail:check', row.listenerCheck)) {
    const slot = detail.querySelector('[data-entry-part="check"]'); slot.replaceChildren();
    if (row.listenerCheck) {
      const check = row.listenerCheck, status = activityStatus(check), section = element('aside', null, 'detail-section handoff-section');
      const metadata = activityMetadata(check, row), at = element('time', `${metadata.clockLabel} ${when(metadata.clock, true)} · ${metadata.revision}`, 'detail-facts'); at.dateTime = metadata.clock ?? '';
      const header = element('div', null, 'detail-meta'); header.append(pill(status.label, status.tone), at);
      section.append(element('h3', 'Latest research check'), header, element('p', activityReason(check)));
      const focus = reviewFocusPresentation(check.focus, { prepared: check.responseReceived !== true }), details = element('details');
      details.append(element('summary', focus.label), element('p', focus.text, 'focus-copy')); section.append(details); slot.append(section);
    }
  }
  if (!changed('entry-detail:live', [row.handoff, row.listener, row.ticket])) return;
  const live = detail.querySelector('[data-entry-part="live"]'); live.replaceChildren();
  const revision = listenerRevisionPresentation(row);
  if (row.handoff || (!row.ticket && row.listener?.status === 'observed')) {
    const section = element('aside', null, 'detail-section handoff-section'), title = element('div', null, 'handoff-head'), mark = element('img');
    mark.src = '/flusso-mark.png'; mark.alt = ''; mark.width = mark.height = 18; title.append(mark, element('h3', !row.ticket && row.listener?.status === 'observed' ? 'Completed research response' : 'Listener status')); section.append(title);
    const review = listenerResult(row);
    if (!row.ticket && row.listener?.status === 'observed' && review) {
      const metadata = activityMetadata(row.listener, row), line = element('div', null, 'detail-meta'), at = element('time', `${metadata.clockLabel} ${when(metadata.clock, true)}`, 'detail-facts'); at.dateTime = metadata.clock ?? '';
      line.append(pill(review.label, review.tone), at); section.append(line, element('p', activityReason(row.listener), 'verdict-reason'));
      if (row.handoff?.context?.listenerEnabled === false) section.append(element('p', 'Listener is off.', 'hint'));
      const focus = reviewFocusPresentation(row.listener.focus), details = element('details');
      details.append(element('summary', 'Review details'));
      if (revision) details.append(element('p', revision.note, 'hint interface-numbers'));
      details.append(element('p', focus.label, 'hint'), element('p', focus.text, 'focus-copy'));
      if (row.handoff) details.append(element('p', row.handoff.reason, 'hint'));
      section.append(details);
    }
    else if (row.handoff) section.append(element('p', row.handoff.reason, 'hint'));
    live.append(section);
  }
  if (row.ticket) {
    const section = element('section', null, 'detail-section'), head = element('div', null, 'card-head');
    head.append(element('h3', row.ticket.kind === 'close' ? 'Close ticket' : 'Order ticket'), row.ticket.ticket?.id ? element('code', row.ticket.ticket.id) : element('span')); section.append(head);
    const outcome = listenerResult(row);
    if (outcome && (!row.ticket.error || row.listener)) {
      const line = element('p', null, 'hint ticket-result');
      line.append(pill(outcome.label, outcome.tone), document.createTextNode(row.listener ? ` ${when(row.listener.atUtc)}${row.listener.reason ? ` · ${row.listener.reason}` : ''}` : ' The listener has not acted on this ticket yet.')); section.append(line);
      if (revision) section.append(element('p', revision.note, 'hint interface-numbers'));
    }
    if (row.ticket.error) section.append(element('p', row.ticket.error, 'hint'), element('p', 'Correct the ticket and save a new revision before it can be checked.', 'hint'));
    else section.append(row.ticket.kind === 'close' ? positionsTable(row.ticket.ticket.positionIds) : ordersTable(row.ticket.ticket.orders));
    live.append(section);
  }
}
// The editor takes the reading pane's place, so the list stays in view while writing.
function showEditor(row = null) {
  if (entrySaving) { notify('This entry is still saving. Wait for the result before opening another entry.'); return; }
  if (editorDirty()) { keepDraftVisible(); return; }
  editing = row?.id ? row : null; entryRetryKey = crypto.randomUUID();
  $('editor').hidden = false; $('entry-detail').hidden = true; $('editor-title').textContent = editing ? 'Edit entry' : row ? 'Copy to local' : 'New entry';
  const notebooks = snapshot.notebooks.filter(item => item.origin === 'local');
  $('entry-notebook').replaceChildren(...notebooks.map(item => new Option(item.name, item.id)));
  if (row?.origin === 'local') $('entry-notebook').value = row.notebookId;
  $('entry-title').value = row?.title ?? ''; $('entry-body').value = row?.body ?? ''; $('entry-status').value = row?.status ?? 'watching'; $('entry-signal').value = row?.signal ? JSON.stringify(row.signal, null, 2) : '';
  editorBase = editorValues(); updateDraftProtection(); reveal($('editor'), window.matchMedia('(max-width:760px)').matches ? 'start' : 'nearest'); $('entry-title').focus({ preventScroll: true });
}
// Picking another entry keeps the draft; Cancel requires an explicit discard choice.
let editorBase = null, reportedDraftDirty, entrySaving = false;
function editorValues() { return { notebookId: $('entry-notebook').value, title: $('entry-title').value, body: $('entry-body').value, status: $('entry-status').value, signal: $('entry-signal').value }; }
function editorDirty() { return !$('editor').hidden && localDraftDirty(editorBase, editorValues()); }
function protectDraftOnLeave(event) { if (entrySaving || editorDirty()) { event.preventDefault(); event.returnValue = ''; } }
function updateDraftProtection() {
  const dirty = entrySaving || editorDirty();
  if (desktop?.setDraftDirty && dirty !== reportedDraftDirty) {
    try { if (desktop.setDraftDirty(dirty) === true) reportedDraftDirty = dirty; } catch { /* Keep the renderer unload fallback; native unknown state requires confirmation. */ }
  }
  if (dirty) window.addEventListener('beforeunload', protectDraftOnLeave);
  else window.removeEventListener('beforeunload', protectDraftOnLeave);
}
function keepDraftVisible() {
  switchView('journal');
  notify('Your local draft is still open. Save it, or choose Cancel to discard it.');
  reveal($('editor'), window.matchMedia('(max-width:760px)').matches ? 'start' : 'nearest'); $('entry-title').focus({ preventScroll: true });
}
$('entry-form').addEventListener('input', updateDraftProtection);
$('entry-form').addEventListener('change', updateDraftProtection);
function leaveEditor() {
  if (entrySaving) { notify('This entry is still saving. Wait for the result before opening another entry.'); return false; }
  if ($('editor').hidden) return true;
  if (editorDirty()) { keepDraftVisible(); return false; }
  closeEditor(); return true;
}
function closeEditor({ focus = false } = {}) {
  if (entrySaving) { notify('This entry is still saving. Wait for the result before closing it.'); return; }
  if ($('editor').hidden) return;
  $('editor').hidden = true; $('entry-detail').hidden = false; editorBase = null; updateDraftProtection();
  if (focus) (document.querySelector('.entry-card.selected') ?? $('new-entry')).focus();
}
function insertTicket(close = false) {
  const id = `ticket-${crypto.randomUUID()}`;
  const body = $('entry-body'), block = '```' + (close ? 'flusso-close' : 'flusso-orders') + '\n' + JSON.stringify(ticketDraft(id, close), null, 2) + '\n```\n';
  if (TICKET_FENCE.test(body.value)) { TICKET_FENCE.lastIndex = 0; notify('This entry already has an action ticket.'); return; }
  TICKET_FENCE.lastIndex = 0; body.value = `${body.value.trimEnd()}${body.value.trim() ? '\n\n' : ''}${block}`; $('entry-status').value = 'watching'; updateDraftProtection(); body.focus();
  notify(close ? 'Close ticket draft added. Add exact owned position IDs; an empty draft cannot run.' : 'Order ticket draft added. Add your exact orders; an empty draft cannot run.');
}
$('insert-ticket').addEventListener('click', () => insertTicket());
$('insert-close-ticket').addEventListener('click', () => insertTicket(true));
$('result-filter').replaceChildren(...RESULT_FILTERS.map(option => new Option(option.label, option.value)));
$('journal-filter').addEventListener('change', renderEntries);
$('result-filter').addEventListener('change', renderEntries);
$('new-entry').addEventListener('click', () => showEditor());
$('cancel-edit').addEventListener('click', () => { if (editorDirty()) $('discard-entry').showModal(); else closeEditor({ focus: true }); });
$('keep-writing').addEventListener('click', () => $('discard-entry').close());
$('discard-writing').addEventListener('click', () => { $('discard-entry').close(); closeEditor({ focus: true }); });
$('entry-form').addEventListener('submit', event => {
  event.preventDefault(); if (entrySaving) return;
  const form = $('entry-form'), controls = [...form.elements].filter(control => 'disabled' in control).map(control => [control, control.disabled]);
  entrySaving = true; form.setAttribute('aria-busy', 'true'); controls.forEach(([control]) => { control.disabled = true; }); updateDraftProtection();
  let released = false;
  const releaseSave = () => {
    if (released) return; released = true;
    controls.forEach(([control, disabled]) => { control.disabled = disabled; });
    form.removeAttribute('aria-busy'); entrySaving = false; updateDraftProtection();
  };
  action(null, async () => { try {
  let signal = null; if ($('entry-signal').value.trim()) { try { signal = JSON.parse($('entry-signal').value); } catch { throw new Error('The structured signal is not valid JSON.'); } }
  const body = { notebookId: $('entry-notebook').value, title: $('entry-title').value, body: $('entry-body').value, status: $('entry-status').value, source: editing?.source ?? 'manual', observedAtUtc: editing?.observedAtUtc ?? null, instrument: editing?.instrument ?? null, venue: editing?.venue ?? null, signal, ...(editing ? { version: editing.version } : {}) };
  const saved = await api(editing ? `/api/entries/${editing.id}` : '/api/entries', body, { 'Idempotency-Key': entryRetryKey });
  selected = { ...saved, origin: 'local' };
  snapshot.entries = [selected, ...snapshot.entries.filter(row => row.origin !== selected.origin || row.id !== selected.id)];
  showSelectedEntry(); renderEntries(); releaseSave(); closeEditor({ focus: true });
  const returnFocus = document.activeElement;
  try { await load(); } catch { notify('Entry saved, but the list could not refresh. Refresh to check the latest entries.', false, true); return; }
  renderEntries();
  if (document.activeElement === returnFocus || $('entry-list').contains(document.activeElement) && document.activeElement.dataset.rowKey === returnFocus?.dataset.rowKey) (document.querySelector('.entry-card.selected') ?? $('new-entry')).focus({ preventScroll: true });
  notify('Saved.', true);
  } finally { releaseSave(); } });
});
$('notebook-form').addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => { await api('/api/notebooks', { name: $('notebook-name').value }); $('notebook-name').value = ''; await load({ forms: !formDirty }); notify('Notebook added.', true); }); });
$('sync').addEventListener('click', event => action(event.currentTarget, async () => { const result = await api('/api/sync', {}); await load(); notify(result.complete ? 'Cloud Journal synced.' : result.reason, result.complete); }));

/* ------------------------------------------------------------ connection */
async function changeConnection(connect) {
  if ((connectionBusy && connect) || connectionOperation === 'disconnect') return;
  const generation = ++connectionGeneration;
  connectionBusy = true; connectionOperation = connect ? 'connect' : 'disconnect'; profileGeneration++; profileConnectionKey = null; accountsKey = undefined; renderAccount(); closeAccountMenu();
  try {
    if (connect) notify('Finish signing in from your browser.');
    await api(connect ? '/api/connect' : '/api/disconnect', {}); if (generation !== connectionGeneration) return;
    await load({ forms: true }); if (generation !== connectionGeneration) return;
    notify(connect ? 'Flusso connected.' : 'Disconnected. The Listener is off.', true);
  } catch (error) { if (generation === connectionGeneration) notify(error.message, false, true); }
  finally { if (generation === connectionGeneration) { connectionBusy = false; connectionOperation = null; renderAccount(); refreshAccountProfile(); loadAccounts(); } }
}
for (const id of ['connect', 'account-connect']) $(id).addEventListener('click', () => changeConnection(true));
$('account-disconnect').addEventListener('click', () => changeConnection(false));

/* -------------------------------------------------------------- activity */
function renderActivity() {
  const rows = latestDecisions(snapshot.activity, snapshot.listener.lastModelOutput, { limit: null });
  const attempts = new Map(snapshot.attempts.map(row => [row.id, row]));
  const items = decisionItems(rows, row => ({ attempt: row.attemptId ? attempts.get(row.attemptId) : null, ...activityMetadata(row, snapshot.entries.find(entry => entry.id === row.entryId && entry.origin === row.origin)) }));
  if (!rows.length) items.push({ key: 'empty', value: { enabled: snapshot.settings.enabled } });
  if (!changed('activity', items)) return;
  reconcileRows($('activity-list'), items, ({ row, attempt, enabled, revision, clock, clockLabel, historical }) => {
    if (!row) {
      const empty = element('div', null, 'empty-art'), mark = element('img'), open = element('button', 'Open Listener'); open.type = 'button';
      mark.src = '/flusso-mark.png'; mark.alt = ''; mark.width = mark.height = 40;
      open.addEventListener('click', () => switchView('listener'));
      empty.append(mark, element('p', enabled ? 'Nothing yet. Decisions and order receipts are listed here after the Listener reviews a selected note.' : 'Nothing yet. Turn the Listener on to review selected notes; its decisions and order receipts are listed here.'), open);
      return empty;
    }
    const card = element('article', null, 'activity-card'), head = element('div', null, 'activity-head'), status = activityStatus(row, { historical });
    // Seconds, as in Latest decisions: checks can run several times a minute.
    const time = element('time', `${clockLabel} ${when(clock, true)}`); time.dateTime = clock;
    card.dataset.tone = status.tone;
    const summary = element('div', null, 'activity-status'); summary.append(pill(status.label, status.tone), element('span', revision, 'hint mono'));
    head.append(summary, time);
    const title = element('h2'); title.append(sourceButton(row));
    card.append(head, title, element('p', activityReason(row), 'activity-reason'));
    if (row.kind === 'research_check' || ['candidate', 'review', 'ignore'].includes(row.decision) && row.status === 'observed') {
      const focus = reviewFocusPresentation(row.focus, { prepared: row.status !== 'observed' && row.responseReceived !== true }), details = element('details');
      details.append(element('summary', focus.label), element('p', focus.text, 'focus-copy')); card.append(details);
    }
    if (attempt) {
      const receipt = element('section', null, 'receipt'), receiptHead = element('div', null, 'receipt-head'), settled = attempt.receipt?.lines?.length;
      receiptHead.append(element('h3', settled ? 'Receipt' : attempt.kind === 'close' ? 'Requested close' : 'Requested orders'), element('p', `Request ${attempt.id}`, 'hint mono'));
      receipt.append(receiptHead);
      if (settled) receipt.append(attempt.kind === 'close' ? positionsTable(attempt.receipt.lines, true) : ordersTable(attempt.receipt.lines, true));
      else receipt.append(attempt.kind === 'close' ? positionsTable(attempt.positionIds ?? []) : ordersTable(attempt.orders));
      card.append(receipt);
    }
    if (attempt && ['pending', 'unknown'].includes(attempt.status)) {
      const actions = element('div', null, 'form-actions resolve-actions'), resolve = element('button', 'I checked Flusso. Mark resolved'); resolve.type = 'button';
      resolve.dataset.rowControl = 'resolve';
      resolve.addEventListener('click', () => action(resolve, async () => { await api(`/api/attempts/${encodeURIComponent(attempt.id)}/resolve`, {}); await load(); notify('Marked resolved. New tickets can be placed.', true); }));
      actions.append(element('p', 'This result is unconfirmed and will never be resent. New tickets wait until you check orders and positions in Flusso and mark it resolved.', 'hint'), resolve); card.append(actions);
    }
    return card;
  });
}

// EventSource reconnects to the same authenticated local status resource. A
// missed connection cannot turn an incomplete response into an accepted decision.
let listenerEvents, streamDisconnected = false;
function streamListener() {
  listenerEvents = new EventSource('/api/status');
  listenerEvents.onerror = () => { streamDisconnected = true; if (snapshot) { renderStatus(); renderProcess(); } };
  listenerEvents.onmessage = event => {
    streamDisconnected = false;
    const listener = JSON.parse(event.data);
    if (!snapshot || listener.sequence < (snapshot.listener.sequence ?? 0)) return;
    const finished = snapshot.listener.busy && !listener.busy;
    snapshot.listener = listener;
    renderStatus(); renderProcess(); renderDecisions(); renderActivity();
    if (finished) load().catch(error => notifyPollFailure(error.message));
  };
}
window.addEventListener('pagehide', () => listenerEvents?.close());

/* ------------------------------------------------------------------ boot */
let initializing = false, initialized = false, bootstrapFragment = location.hash.slice(1);
history.replaceState(null, '', '/');
async function initialize() {
  const fragment = bootstrapFragment;
  if (fragment) { try { csrf = (await api('/api/bootstrap', {}, { Authorization: `Bearer ${fragment}` })).csrf; } catch { csrf = (await api('/api/session')).csrf; } }
  else csrf = (await api('/api/session')).csrf;
  bootstrapFragment = '';
  await load({ forms: true });
  streamListener();
  setInterval(async () => {
    const interval = listenerEvents?.readyState === EventSource.OPEN ? 10000 : (!$('view-listener').hidden || snapshot?.listener.busy ? 1500 : 10000);
    if (document.hidden || pollBusy || Date.now() - lastPolledAt < interval) return;
    pollBusy = true; lastPolledAt = Date.now();
    try { await load(); } catch (error) { notifyPollFailure(error.message); } finally { pollBusy = false; }
  }, 1500);
}
async function startWorkspace() {
  if (initializing || initialized) return;
  initializing = true; $('retry-initialize').hidden = true; $('startup').className = 'notice'; $('startup').setAttribute('role', 'status');
  setText('startup-message', 'Loading Journal…');
  try {
    await initialize(); initialized = true;
    $('workspace').inert = false; $('workspace').setAttribute('aria-busy', 'false'); $('startup').hidden = true;
  } catch {
    setText('startup-message', 'Journal could not load. Retry to read the saved state. If the session expired, reopen Journal from its private launcher.');
    $('retry-initialize').hidden = false; $('startup').className = 'notice error'; $('startup').setAttribute('role', 'alert');
  } finally { initializing = false; }
}
$('retry-initialize').addEventListener('click', startWorkspace);
renderThemes();
startWorkspace();
initializeDesktop().catch(error => { $('app-update-status').textContent = 'Desktop status unavailable'; notify(error.message || 'Desktop status could not be read.', false, true); });
