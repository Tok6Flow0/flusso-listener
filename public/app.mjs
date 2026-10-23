import { formatCount, formatPrice, formatQuantity, formatPercentLabel, formatMoney, formatPercent } from './format.mjs';
import { renderMarkdown } from './markdown.mjs';
import { accountPresentation, updatePresentation, modelPresentation, THEME_OPTIONS, resolveTheme, entryStatus, activityStatus, listenerResult, RESULT_FILTERS, matchesResultFilter, processStage, processingPresentation, latestDecisions, receiptDetails, modelOutputPresentation, intervalLabel } from './desktop-ui.mjs';

const $ = id => document.getElementById(id);
let csrf, snapshot, selected = null, editing = null, entryRetryKey = crypto.randomUUID();
const desktop = window.flussoDesktop;
let desktopStatus = null, connectionBusy = false, connectionOperation = null, connectionGeneration = 0, profileConnectionKey = null, profileGeneration = 0, dismissedUpdate = null;
let accounts = [], accountsKey = null, formDirty = false, themeMode = document.documentElement.dataset.themeMode || 'system';
const nativeTasks = new Set();
const renderKeys = new Map();
let pollBusy = false, lastPolledAt = 0;
const TICKET_EXAMPLE = { id: 'kaia-2026-10-12T14', together: true, orders: [
  { instrumentId: 'gate:KAIA_USDT', side: 'buy', quantity: 120, limitPrice: 0.1234, conditions: { maxSlippagePct: 3 } },
  { instrumentId: 'bybit:KAIAUSDT', side: 'sell', quantity: 12, limitPrice: 0.1236, conditions: { maxSlippagePct: 3 } },
] };
const TICKET_FENCE = /^(```|~~~)[ \t]*flusso-(?:orders|close)[ \t]*\n[\s\S]*?^\1[ \t]*$/gm;

function element(tag, content, className) { const node = document.createElement(tag); if (content != null) node.textContent = content; if (className) node.className = className; return node; }
function pill(text, tone) { return element('span', text, `pill${tone ? ' ' + tone : ''}`); }
function notify(message, success = false) { $('notice').hidden = false; $('notice-text').textContent = message; $('notice').className = `notice${success ? ' success' : ''}`; clearTimeout(notify.timer); if (success) notify.timer = setTimeout(() => { $('notice').hidden = true; }, 5000); }
async function api(path, body, headers = {}) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-flusso-csrf': csrf }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'That did not work. Try again.'); return value;
}
async function action(button, work) { if (button?.disabled) return; if (button) button.disabled = true; try { await work(); } catch (error) { notify(error.message); } finally { if (button) button.disabled = false; } }
function when(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
function timeOf(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
function changed(key, value) { const next = JSON.stringify(value); if (renderKeys.get(key) === next) return false; renderKeys.set(key, next); return true; }
// Writes only real changes, so live regions announce a state once rather than on every token.
function setText(id, value) { const node = $(id); if (node.textContent !== value) node.textContent = value; }
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function reveal(node, block = 'start') { node.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block }); }
$('dismiss-notice').addEventListener('click', () => { clearTimeout(notify.timer); $('notice').hidden = true; });

/* ------------------------------------------------------------ appearance */
function applyTheme(mode = themeMode) {
  themeMode = mode;
  const theme = resolveTheme(mode, matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.dataset.themeMode = mode;
  for (const button of $('theme-grid').children) button.setAttribute('aria-checked', String(button.dataset.mode === mode));
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
function renderAccountChoice() {
  const current = $('account').value || snapshot?.settings.accountId || '';
  const options = accounts.map(row => new Option(row.displayName || row.publicId, row.id));
  $('account').replaceChildren(new Option(snapshot?.cloud.connected ? (accounts.length ? 'Choose an account' : 'No accounts found') : 'Connect Flusso first', ''), ...options);
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
  $('model-setup').hidden = !model.visible;
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
  catch (error) { notify(error.message || 'That did not work. Try again.'); }
  finally { nativeTasks.delete(method); renderDesktop(); }
}
async function initializeDesktop() {
  if (!desktop) return;
  const unsubscribe = desktop.onStatus(status => { desktopStatus = status; renderDesktop(); });
  window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
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
  if (!desktop) $('model-state').textContent = snapshot.model.installed ? 'Qwen3 1.7B is ready through Ollama.' : snapshot.model.available ? 'Ollama is running. Download the model:' : 'Start Ollama, then download the model:';
  $('sync').disabled = !snapshot.cloud.connected;
  const selectedFilter = $('journal-filter').value;
  $('journal-filter').replaceChildren(new Option('All notebooks', ''), ...snapshot.notebooks.map(row => new Option(row.origin === 'cloud' ? `${row.name} · cloud` : row.name, `${row.origin}:${row.id}`)));
  $('journal-filter').value = selectedFilter;
  if (changed('entries', snapshot.entries)) renderEntries();
  if (changed('activity', [snapshot.activity, snapshot.attempts, snapshot.settings.enabled])) renderActivity();
  renderProcess(); renderDecisions();
  if (forms || !formDirty) fillSettings();
}
function renderStatus() {
  const { settings, listener } = snapshot;
  const tone = !settings.enabled ? '' : listener.lastError ? 'warn' : 'on';
  $('listener-dot').className = `nav-dot ${tone}${settings.enabled && listener.busy ? ' busy' : ''}`;
  $('listener-dot-label').textContent = !settings.enabled ? 'Off' : listener.lastError ? 'Needs attention' : listener.busy ? 'Reviewing' : 'On';
  // The schedule lives here; the review desk owns state, errors and the next action.
  const interval = intervalLabel(settings.intervalSeconds), parts = [];
  if (!settings.enabled) parts.push('Not checking');
  else {
    if (interval) parts.push(`Checks every ${interval}`);
    parts.push(listener.lastCheckedAtUtc ? `Last checked ${when(listener.lastCheckedAtUtc)}` : 'Not checked yet');
    if (listener.cloudComplete === false) parts.push('Cloud read incomplete');
  }
  setText('last-check', parts.join(' · '));
  $('last-check').classList.toggle('warn', Boolean(settings.enabled && listener.cloudComplete === false));
  const pending = snapshot.attempts.filter(row => ['pending', 'unknown'].includes(row.status)).length;
  $('activity-count').hidden = !pending; $('activity-count').textContent = formatCount(pending);
  $('check-now').disabled = !settings.enabled || Boolean(listener.busy);
  $('check-now').textContent = listener.busy ? 'Checking…' : 'Check now';
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
  button.addEventListener('click', () => { openEntry(entry); });
  return button;
}
function openEntry(entry) {
  switchView('journal'); if (!leaveEditor()) return;
  selected = entry; renderEntries();
  reveal($('entry-detail'), 'start'); $('entry-detail').focus({ preventScroll: true });
}

// The raw response stays one click away once a decision is published.
let rawOpen = false;
$('model-raw-toggle').addEventListener('click', () => { rawOpen = !rawOpen; renderProcess(); if (rawOpen) $('model-output').focus({ preventScroll: true }); });

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

function renderProcess() {
  const { listener, settings } = snapshot, output = listener.modelOutput;
  const state = processingPresentation(listener, settings.enabled);
  const view = modelOutputPresentation(output, listener.lastModelOutput, { disconnected: streamDisconnected, enabled: settings.enabled, busy: listener.busy });
  const desk = $('review-desk');
  desk.dataset.state = state.state; desk.dataset.live = String(view.live);
  setText('process-state', state.title);
  const stage = state.busy ? `${state.label}${state.position ? ` · ${formatCount(state.position.index)} of ${formatCount(state.position.total)}` : ''}` : '';
  setText('process-stage', stage); $('process-stage').hidden = !stage;
  setText('process-message', state.message);

  $('output-frame').dataset.status = view.status;
  setText('model-output-heading', !settings.enabled && output ? 'Last model response' : 'Model output');
  setText('model-output-status', !settings.enabled && view.status === 'complete' ? 'Last check complete' : view.label); $('model-output-status').className = `output-status ${view.tone}`;
  if (changed('model-output-source', output ? [output.entryId, output.origin, output.title, output.atUtc, snapshot.entries.some(row => row.id === output.entryId && row.origin === output.origin)] : null)) {
    const source = $('model-output-source');
    if (output) { const time = element('time', when(output.atUtc)); time.dateTime = output.atUtc; source.replaceChildren(sourceButton(output, output.title || 'Journal entry'), time); }
    else source.replaceChildren();
    source.hidden = !output;
  }
  // Keep the raw answer open if a keyboard reader is using it as it completes.
  if (view.verdict && $('model-output').contains(document.activeElement)) rawOpen = true;
  // Scheduled checks must not strand a keyboard reader inside a hidden verdict.
  if (!view.verdict && $('model-verdict').contains(document.activeElement)) $('model-output-heading').focus({ preventScroll: true });
  $('model-verdict').hidden = !view.verdict;
  if (view.verdict) {
    setText('model-verdict-label', view.verdict.label); $('model-verdict-label').className = `pill ${view.verdict.tone}`;
    setText('model-verdict-reason', view.verdict.reason || 'The model gave no reason.');
    setText('model-raw-toggle', rawOpen ? 'Hide raw response' : 'Show raw response'); $('model-raw-toggle').setAttribute('aria-expanded', String(rawOpen));
  }
  renderOutputText(output);
  $('model-output').hidden = !output?.text || (Boolean(view.verdict) && !rawOpen);
  setText('model-output-note', view.note ?? ''); $('model-output-note').hidden = !view.note;
  setText('model-output-empty', view.empty ?? ''); $('model-output-empty').hidden = !view.empty;

  const events = (listener.events ?? []).slice(-30);
  if (!changed('process-events', events)) return;
  const list = $('process-events'), atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.replaceChildren(...events.map(row => {
    const item = element('li', null, `process-event${row.stage === 'error' ? ' warn' : ''}`), time = element('time', timeOf(row.atUtc)); time.dateTime = row.atUtc;
    const head = element('div', null, 'event-head'), body = element('div', null, 'event-body');
    head.append(element('span', processStage(row.stage), 'event-stage'), time);
    if (row.title) body.append(sourceButton(row));
    if (row.message) body.append(element('p', row.message));
    item.append(head, body); return item;
  }));
  list.hidden = !events.length; $('process-events-empty').hidden = Boolean(events.length);
  setText('process-count', events.length ? `${formatCount(events.length)} update${events.length === 1 ? '' : 's'}` : '');
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function renderDecisions() {
  const latest = latestDecisions(snapshot.activity, snapshot.listener.lastModelOutput);
  if (!changed('decisions', [latest, snapshot.settings.enabled])) return;
  $('latest-decisions').replaceChildren(...latest.map(row => {
    const item = element('article', null, 'decision-row'), top = element('div', null, 'decision-top'), source = element('div', null, 'decision-source'), status = activityStatus(row);
    const time = element('time', when(row.atUtc)); time.dateTime = row.atUtc;
    top.append(pill(status.label, status.tone), time); source.append(sourceButton(row));
    item.append(top, source, element('p', row.reason || 'Processing this entry.', 'decision-excerpt')); return item;
  }));
  if (!latest.length) $('latest-decisions').append(element('p', snapshot.settings.enabled ? 'No decisions yet. Each published model decision and order result is listed here after a check.' : 'No decisions yet. Turn the Listener on; published model decisions and order results are listed here.', 'empty'));
}

/* -------------------------------------------------------------- settings */
function fillSettings() {
  const settings = snapshot.settings, risk = settings.risk ?? {};
  $('enabled').checked = settings.enabled; $('enabled-label').textContent = settings.enabled ? 'On' : 'Off';
  $('execution').checked = settings.executionEnabled;
  for (const radio of document.querySelectorAll('input[name=source]')) radio.checked = radio.value === settings.source;
  ensureOption($('interval'), settings.intervalSeconds, `${formatCount(settings.intervalSeconds)} seconds`); $('interval').value = String(settings.intervalSeconds);
  ensureOption($('max-age'), settings.maxSignalAgeSeconds, `${formatCount(Math.round(settings.maxSignalAgeSeconds / 60))} minutes`); $('max-age').value = String(settings.maxSignalAgeSeconds);
  $('section').value = settings.section; $('instructions').value = settings.instructions;
  $('max-slippage').value = risk.maxSlippagePct ?? ''; $('max-order').value = risk.maxOrderUsd ?? ''; $('min-volume').value = risk.minVolume24hUsd ?? '';
  $('max-tickets').value = settings.maxTicketsPerDay ?? 24; $('max-ticket').value = risk.maxTicketUsd ?? ''; $('max-leverage').value = risk.maxLeverage ?? '';
  $('together').checked = risk.together !== false;
  $('write-back').checked = settings.writeBack !== false;
  $('watch-notebooks').replaceChildren(...snapshot.notebooks.map(row => {
    const label = element('label'), input = element('input'), chip = element('span', row.name);
    input.type = 'checkbox'; input.value = row.id; input.checked = settings.notebookIds.includes(row.id);
    if (row.origin === 'cloud') chip.append(element('small', 'cloud'));
    label.append(input, chip); return label;
  }));
  if (!snapshot.notebooks.length) $('watch-notebooks').append(element('span', 'No notebooks yet.', 'hint'));
  renderAccountChoice();
  formDirty = false; $('save-settings').disabled = true; $('save-settings').textContent = 'Saved';
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
async function saveSettings(message) {
  try { await api('/api/settings', settingsBody()); await load({ forms: true }); notify(message, true); }
  catch (error) { await load({ forms: true }).catch(() => {}); throw error; }
}
$('settings-form').addEventListener('input', () => { formDirty = true; $('save-settings').disabled = false; $('save-settings').textContent = 'Save'; });
$('settings-form').addEventListener('submit', event => { event.preventDefault(); action(event.submitter, () => saveSettings('Saved.')); });
// Switches act immediately, like any other switch.
$('enabled').addEventListener('change', event => { event.stopPropagation(); action(null, () => saveSettings($('enabled').checked ? 'Listener on. The newest selected research note will be reviewed each period.' : 'Listener off.')); });
$('execution').addEventListener('change', event => { event.stopPropagation(); action(null, () => saveSettings($('execution').checked ? 'Auto-trade on.' : 'Auto-trade off.')); });
$('enabled').addEventListener('input', event => event.stopPropagation());
$('execution').addEventListener('input', event => event.stopPropagation());
$('check-now').addEventListener('click', event => action(event.currentTarget, async () => { await api('/api/check', {}); await load(); if (!snapshot.settings.enabled) notify('Turn the Listener on first.'); }));
$('ticket-example').textContent = '```flusso-orders\n' + JSON.stringify(TICKET_EXAMPLE, null, 2) + '\n```';

/* --------------------------------------------------------------- journal */
function renderEntries() {
  const filter = $('journal-filter').value, result = $('result-filter').value;
  const rows = snapshot.entries.filter(row => (!filter || `${row.origin}:${row.notebookId}` === filter) && matchesResultFilter(row, result));
  $('entry-list').replaceChildren(...rows.map(row => {
    const button = element('button', null, 'entry-card'), isSelected = selected?.id === row.id && selected.origin === row.origin; button.type = 'button';
    button.classList.toggle('selected', isSelected); if (isSelected) button.setAttribute('aria-current', 'true');
    const meta = element('span', null, 'meta'), status = entryStatus(row), outcome = listenerResult(row), book = notebookName(row);
    meta.append(element('time', when(row.updatedAtUtc)));
    if (book) meta.append(element('span', book, 'meta-book'));
    const tags = element('span', null, 'tags');
    tags.append(element('span', row.status, `entry-state ${row.status}`));
    if (row.ticket?.error && status) tags.append(pill(status.label, status.tone));
    else if (outcome) tags.append(pill(outcome.label, outcome.tone));
    if (row.origin === 'cloud') tags.append(pill('cloud'));
    button.append(element('strong', row.title), meta, tags);
    button.addEventListener('click', () => openEntry(row)); return button;
  }));
  if (!rows.length) {
    const empty = element('div', null, 'empty list-empty');
    if (snapshot.entries.length) {
      const clear = element('button', 'Show all entries', 'link-button'); clear.type = 'button';
      clear.addEventListener('click', () => { $('journal-filter').value = ''; $('result-filter').value = ''; renderEntries(); });
      empty.append(element('p', 'No entries match these filters.'), clear);
    } else {
      const write = element('button', 'Write the first entry', 'link-button'); write.type = 'button';
      write.addEventListener('click', () => showEditor());
      empty.append(element('p', 'Your Journal is empty.'), write);
    }
    $('entry-list').append(empty);
  }
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
  const detail = $('entry-detail');
  if (!selected) {
    const empty = element('div', null, 'empty-art'), mark = element('img'); mark.src = '/flusso-mark.png'; mark.alt = ''; mark.width = mark.height = 40;
    const write = element('button', snapshot?.entries.length ? 'New entry' : 'Write the first entry'); write.type = 'button';
    write.addEventListener('click', () => showEditor());
    empty.append(mark, element('p', snapshot?.entries.length ? 'Pick an entry to read it, or write a new one.' : 'Write research, questions or an explicit order ticket. Notes stay on this computer unless you copy them.'), write);
    detail.replaceChildren(empty); return;
  }
  const row = selected; detail.setAttribute('aria-label', row.title); detail.replaceChildren();
  const head = element('header', null, 'detail-head'), heading = element('div', null, 'detail-title');
  const meta = element('div', null, 'detail-meta'), status = entryStatus(row), book = notebookName(row);
  meta.append(pill(row.status, row.status === 'watching' ? 'info' : ''));
  if (status) meta.append(pill(status.label, status.tone));
  const facts = element('span', null, 'detail-facts mono'), time = element('time', when(row.updatedAtUtc)); time.dateTime = row.updatedAtUtc ?? '';
  facts.append(document.createTextNode(`${book ? `${book} · ` : ''}${row.origin} · v${formatCount(row.version)} · `), time);
  meta.append(facts);
  heading.append(element('h2', row.title), meta);
  const actions = element('div', null, 'detail-actions'), button = element('button', row.origin === 'local' ? 'Edit' : 'Copy to local'); button.type = 'button';
  button.addEventListener('click', () => showEditor(row.origin === 'local' ? row : { ...row, id: null, version: null })); actions.append(button);
  head.append(heading, actions);
  const prose = element('div', null, 'note-body'); renderMarkdown(prose, (row.body || '').replace(TICKET_FENCE, '').trim() || ' ');
  detail.append(head, prose);
  if (row.handoff || (!row.ticket && row.listener?.status === 'observed')) {
    const section = element('aside', null, 'detail-section handoff-section'), title = element('div', null, 'handoff-head'), mark = element('img');
    mark.src = '/flusso-mark.png'; mark.alt = ''; mark.width = mark.height = 18;
    title.append(mark, element('h3', 'Listener status'));
    section.append(title);
    const review = listenerResult(row);
    if (!row.ticket && row.listener?.status === 'observed' && review) {
      const line = element('p', null, 'handoff-review'), at = element('time', when(row.listener.atUtc)); at.dateTime = row.listener.atUtc ?? '';
      line.append(pill(review.label, review.tone), element('span', row.listener.reason || 'No reason given.'), at);
      section.append(line);
    }
    if (row.handoff) section.append(element('p', row.handoff.reason, 'hint'));
    detail.append(section);
  }
  if (row.ticket) {
    const section = element('section', null, 'detail-section'), head = element('div', null, 'card-head');
    head.append(element('h3', row.ticket.kind === 'close' ? 'Close ticket' : 'Order ticket'), row.ticket.ticket?.id ? element('code', row.ticket.ticket.id) : element('span'));
    section.append(head);
    const outcome = listenerResult(row);
    if (outcome) {
      const line = element('p', null, 'hint ticket-result');
      line.append(pill(outcome.label, outcome.tone), document.createTextNode(row.listener ? ` ${when(row.listener.atUtc)}${row.listener.reason ? ` · ${row.listener.reason}` : ''}` : ' The listener has not acted on this ticket yet.'));
      section.append(line);
    }
    if (row.ticket.error) section.append(element('p', row.ticket.error, 'hint'));
    else section.append(row.ticket.kind === 'close' ? positionsTable(row.ticket.ticket.positionIds) : ordersTable(row.ticket.ticket.orders));
    detail.append(section);
  }
  if (row.signal) {
    const section = element('section', null, 'detail-section');
    section.append(element('h3', 'Structured signal'), element('p', `${row.signal.quality} · ${row.signal.sourceOperationId} · ${row.signal.sourceAsOfUtc ? when(row.signal.sourceAsOfUtc) : 'no source time'}`, 'hint mono'));
    const wrap = element('div', null, 'table-scroll'), table = element('table'), thead = element('thead'), head = element('tr'), tbody = element('tbody');
    ['Instrument', 'Side', 'Direction', 'Qty', 'Unit', 'Ref price'].forEach((label, index) => head.append(element('th', label, index === 3 || index === 5 ? 'num' : '')));
    thead.append(head); table.append(thead);
    for (const leg of row.signal.legs) { const tr = element('tr'); [leg.asset.instrumentId, leg.side ?? '—', leg.direction ?? '—', formatQuantity(leg.quantity), leg.quantityUnit ? `${leg.quantityUnit} ${leg.quantityAsset ?? ''}` : '—', formatPrice(leg.referencePrice)].forEach((value, index) => tr.append(element('td', value, index === 3 || index === 5 ? 'num' : index === 0 ? 'mono' : ''))); tbody.append(tr); }
    table.append(tbody); wrap.append(table); section.append(wrap); detail.append(section);
  }
}
// The editor takes the reading pane's place, so the list stays in view while writing.
function showEditor(row = null) {
  if (!$('editor').hidden && editorDirty) { notify('Save or cancel the entry you are writing first.'); $('entry-title').focus(); return; }
  editing = row?.id ? row : null; entryRetryKey = crypto.randomUUID();
  $('editor').hidden = false; $('entry-detail').hidden = true; $('editor-title').textContent = editing ? 'Edit entry' : row ? 'Copy to local' : 'New entry';
  const notebooks = snapshot.notebooks.filter(item => item.origin === 'local');
  $('entry-notebook').replaceChildren(...notebooks.map(item => new Option(item.name, item.id)));
  if (row?.origin === 'local') $('entry-notebook').value = row.notebookId;
  $('entry-title').value = row?.title ?? ''; $('entry-body').value = row?.body ?? ''; $('entry-status').value = row?.status ?? 'watching'; $('entry-signal').value = row?.signal ? JSON.stringify(row.signal, null, 2) : '';
  editorDirty = false; reveal($('editor'), 'nearest'); $('entry-title').focus({ preventScroll: true });
}
// Unsaved writing is never discarded by picking another entry; only Cancel discards it.
let editorDirty = false;
$('entry-form').addEventListener('input', () => { editorDirty = true; });
function leaveEditor() {
  if ($('editor').hidden) return true;
  if (editorDirty) { notify('Save or cancel the entry you are writing first.'); $('entry-title').focus(); return false; }
  closeEditor(); return true;
}
function closeEditor({ focus = false } = {}) {
  if ($('editor').hidden) return;
  $('editor').hidden = true; $('entry-detail').hidden = false; editorDirty = false;
  if (focus) (document.querySelector('.entry-card.selected') ?? $('new-entry')).focus();
}
function insertTicket(close = false) {
  const id = `ticket-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '')}`;
  const body = $('entry-body'), block = '```' + (close ? 'flusso-close' : 'flusso-orders') + '\n' + JSON.stringify(close ? { id, positionIds: [] } : { ...TICKET_EXAMPLE, id }, null, 2) + '\n```\n';
  if (TICKET_FENCE.test(body.value)) { TICKET_FENCE.lastIndex = 0; notify('This entry already has an order ticket.'); return; }
  TICKET_FENCE.lastIndex = 0; body.value = `${body.value.trimEnd()}${body.value.trim() ? '\n\n' : ''}${block}`; $('entry-status').value = 'watching'; editorDirty = true; body.focus();
}
$('insert-ticket').addEventListener('click', () => insertTicket());
$('insert-close-ticket').addEventListener('click', () => insertTicket(true));
$('result-filter').replaceChildren(...RESULT_FILTERS.map(option => new Option(option.label, option.value)));
$('journal-filter').addEventListener('change', renderEntries);
$('result-filter').addEventListener('change', renderEntries);
$('new-entry').addEventListener('click', () => showEditor()); $('cancel-edit').addEventListener('click', () => closeEditor({ focus: true }));
$('entry-form').addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => {
  let signal = null; if ($('entry-signal').value.trim()) { try { signal = JSON.parse($('entry-signal').value); } catch { throw new Error('The structured signal is not valid JSON.'); } }
  const body = { notebookId: $('entry-notebook').value, title: $('entry-title').value, body: $('entry-body').value, status: $('entry-status').value, source: editing?.source ?? 'manual', observedAtUtc: editing?.observedAtUtc ?? null, instrument: editing?.instrument ?? null, venue: editing?.venue ?? null, signal, ...(editing ? { version: editing.version } : {}) };
  const saved = await api(editing ? `/api/entries/${editing.id}` : '/api/entries', body, { 'Idempotency-Key': entryRetryKey });
  selected = { ...saved, origin: 'local' }; closeEditor(); await load(); renderEntries(); notify('Saved.', true);
}); });
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
  } catch (error) { if (generation === connectionGeneration) notify(error.message); }
  finally { if (generation === connectionGeneration) { connectionBusy = false; connectionOperation = null; renderAccount(); refreshAccountProfile(); loadAccounts(); } }
}
for (const id of ['connect', 'account-connect']) $(id).addEventListener('click', () => changeConnection(true));
$('account-disconnect').addEventListener('click', () => changeConnection(false));

/* -------------------------------------------------------------- activity */
function renderActivity() {
  const attempts = new Map(snapshot.attempts.map(row => [row.id, row]));
  $('activity-list').replaceChildren(...snapshot.activity.map(row => {
    const card = element('article', null, 'activity-card'), head = element('div', null, 'activity-head'), status = activityStatus(row), attempt = row.attemptId ? attempts.get(row.attemptId) : null;
    const time = element('time', when(row.atUtc)); time.dateTime = row.atUtc;
    card.dataset.tone = status.tone;
    head.append(pill(status.label, status.tone), time);
    const title = element('h2'); title.append(sourceButton(row));
    card.append(head, title, element('p', row.reason, 'activity-reason'));
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
      resolve.addEventListener('click', () => action(resolve, async () => { await api(`/api/attempts/${encodeURIComponent(attempt.id)}/resolve`, {}); await load(); notify('Marked resolved. New tickets can be placed.', true); }));
      actions.append(element('p', 'This result is unconfirmed and will never be resent. New tickets wait until you check orders and positions in Flusso and mark it resolved.', 'hint'), resolve); card.append(actions);
    }
    return card;
  }));
  if (!snapshot.activity.length) {
    const empty = element('div', null, 'empty-art'), mark = element('img'), open = element('button', 'Open Listener'); open.type = 'button';
    mark.src = '/flusso-mark.png'; mark.alt = ''; mark.width = mark.height = 40;
    open.addEventListener('click', () => switchView('listener'));
    empty.append(mark, element('p', snapshot.settings.enabled ? 'Nothing yet. Decisions and order receipts are listed here after the Listener reviews a selected note.' : 'Nothing yet. Turn the Listener on to review selected notes; its decisions and order receipts are listed here.'), open);
    $('activity-list').append(empty);
  }
}

// EventSource reconnects to the same authenticated local status resource. A
// missed connection cannot turn an incomplete response into an accepted decision.
let listenerEvents, streamDisconnected = false;
function streamListener() {
  listenerEvents = new EventSource('/api/status');
  listenerEvents.onerror = () => { streamDisconnected = true; if (snapshot) renderProcess(); };
  listenerEvents.onmessage = event => {
    streamDisconnected = false;
    const listener = JSON.parse(event.data);
    if (!snapshot || listener.sequence < (snapshot.listener.sequence ?? 0)) return;
    const finished = snapshot.listener.busy && !listener.busy;
    snapshot.listener = listener;
    renderStatus(); renderProcess(); renderDecisions();
    if (finished) load().catch(error => notify(error.message));
  };
}
window.addEventListener('pagehide', () => listenerEvents?.close());

/* ------------------------------------------------------------------ boot */
async function initialize() {
  const fragment = location.hash.slice(1); history.replaceState(null, '', '/');
  if (fragment) { try { csrf = (await api('/api/bootstrap', {}, { Authorization: `Bearer ${fragment}` })).csrf; } catch { csrf = (await api('/api/session')).csrf; } }
  else csrf = (await api('/api/session')).csrf;
  await load({ forms: true });
  streamListener();
  setInterval(async () => {
    const interval = listenerEvents?.readyState === EventSource.OPEN ? 10000 : (!$('view-listener').hidden || snapshot?.listener.busy ? 1500 : 10000);
    if (document.hidden || pollBusy || Date.now() - lastPolledAt < interval) return;
    pollBusy = true; lastPolledAt = Date.now();
    try { await load(); } catch (error) { notify(error.message); } finally { pollBusy = false; }
  }, 1500);
}
renderThemes();
initialize().catch(error => notify(error.message));
initializeDesktop().catch(error => { $('app-update-status').textContent = 'Desktop status unavailable'; notify(error.message || 'Desktop status could not be read.'); });
