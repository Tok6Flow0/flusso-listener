import { formatCount, formatPrice, formatQuantity, formatMoney } from './format.mjs';
import { renderMarkdown } from './markdown.mjs';

const $ = id => document.getElementById(id);
let csrf, snapshot, selected = null, editing = null, previewId = null, entryRetryKey = crypto.randomUUID();
function element(tag, content, className) { const node = document.createElement(tag); if (content != null) node.textContent = content; if (className) node.className = className; return node; }
function notify(message, success = false) { $('notice').hidden = false; $('notice').textContent = message; $('notice').className = `notice${success ? ' success' : ''}`; }
async function api(path, body, headers = {}) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-flusso-csrf': csrf }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'The request could not be completed.'); return value;
}
async function action(button, work) { if (button?.disabled) return; if (button) button.disabled = true; try { await work(); } catch (error) { notify(error.message); } finally { if (button) button.disabled = false; } }
function switchView(view) { document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== `view-${view}`; }); document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }); }
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { switchView(button.dataset.view); if (button.dataset.view === 'policy' && snapshot?.cloud.connected) loadExecutionChoices().catch(error => notify(error.message)); }));
async function loadExecutionChoices() {
  const result = await api('/api/execution-choices');
  const priorAccount = $('policy-account').value, priorInstrument = $('policy-instrument').value;
  $('policy-account').replaceChildren(new Option('Choose your account', ''), ...result.accounts.map(row => new Option(row.displayName || row.publicId || 'Trading account', row.id)));
  $('policy-instrument').replaceChildren(new Option('Choose an executable BTC/USD instrument', ''), ...result.instruments.map(row => new Option(`${row.venue} · ${row.symbol}`, row.instrumentId)));
  $('policy-account').value = priorAccount || snapshot.settings.accountId || ''; $('policy-instrument').value = priorInstrument;
  $('execution-choice-warning').textContent = result.warning || 'Choose canonical account and market identities from the connected account. No price or budget is selected for you.';
}

async function load({ forms = false } = {}) {
  snapshot = await api('/api/status');
  $('cloud-state').textContent = snapshot.cloud.connected ? 'Cloud connected' : 'Local only'; $('cloud-state').classList.toggle('on', snapshot.cloud.connected);
  $('listener-state').textContent = snapshot.settings.enabled ? 'Listener on' : 'Listener off'; $('listener-state').classList.toggle('on', snapshot.settings.enabled);
  $('listener-id').textContent = snapshot.settings.listenerId;
  $('connection-detail').textContent = snapshot.cloud.connected ? 'Connected with browser-approved scopes: ' + snapshot.cloud.scopes.join(', ') + '. Revoke this device from your Flusso account to end server access.' : 'Cloud access is optional for a local Journal.';
  $('model-state').textContent = snapshot.model.installed ? 'Local model ready. Inference stays on this computer.' : snapshot.model.available ? 'Ollama is running. Download the model using the command below.' : 'Start Ollama, then download the model using the command below.';
  $('sync').disabled = !snapshot.cloud.connected;
  $('disconnect').disabled = !snapshot.cloud.connected;
  $('last-check').textContent = snapshot.listener.lastError || (snapshot.listener.lastCheckedAtUtc ? 'Last checked: ' + new Date(snapshot.listener.lastCheckedAtUtc).toLocaleString() + (snapshot.listener.cloudComplete === false ? ' · Cloud scan incomplete' : '') : 'No check yet.');
  const selectedFilter = $('journal-filter').value;
  $('journal-filter').replaceChildren(new Option('All notebooks', ''), ...snapshot.notebooks.map(row => new Option(`${row.name} · ${row.origin}`, `${row.origin}:${row.id}`)));
  $('journal-filter').value = selectedFilter;
  renderEntries(); renderActivity();
  if (forms) fillSettings();
}
function fillSettings() {
  const settings = snapshot.settings;
  $('source').value = settings.source; $('interval').value = settings.intervalSeconds; $('section').value = settings.section; $('instructions').value = settings.instructions;
  $('enabled').checked = settings.enabled; $('execution').checked = settings.executionEnabled;
  $('execution').disabled = !snapshot.cloud.connected || !settings.authorizationId;
  $('watch-notebooks').replaceChildren(...snapshot.notebooks.map(row => { const option = new Option(`${row.name} · ${row.origin}`, row.id); option.selected = settings.notebookIds.includes(row.id); return option; }));
  $('selected-policy').textContent = settings.authorizationId || 'No approved policy selected';
  if (settings.accountId) $('policy-account').value = settings.accountId;
}
function renderEntries() {
  const filter = $('journal-filter').value, rows = snapshot.entries.filter(row => !filter || `${row.origin}:${row.notebookId}` === filter);
  $('entry-list').replaceChildren(...rows.map(row => {
    const button = element('button', null, 'entry-card'); button.type = 'button'; button.classList.toggle('selected', selected?.id === row.id && selected.origin === row.origin);
    button.append(element('strong', row.title), element('span', `${row.origin} · ${row.status} · v${formatCount(row.version)}`, 'meta'));
    button.addEventListener('click', () => { selected = row; renderEntries(); renderDetail(); }); return button;
  }));
  if (!rows.length) $('entry-list').append(element('p', 'No entries in this notebook yet.', 'empty'));
  if (selected) { const current = snapshot.entries.find(row => row.id === selected.id && row.origin === selected.origin); if (current) { selected = current; renderDetail(); } }
}
function renderDetail() {
  if (!selected) return;
  const row = selected, detail = $('entry-detail'); detail.replaceChildren(element('h2', row.title));
  const meta = element('div', null, 'detail-meta');
  for (const value of [row.origin, row.status, `v${formatCount(row.version)}`, row.observedAtUtc ? new Date(row.observedAtUtc).toLocaleString() : 'Observation time unavailable']) meta.append(element('span', value, 'pill'));
  const prose = element('div', null, 'note-body'); renderMarkdown(prose, row.body || 'No prose recorded.'); detail.append(meta, prose);
  if (row.signal) {
    detail.append(element('h3', 'Structured observation'), element('p', `${row.signal.quality} · ${row.signal.sourceOperationId} · ${row.signal.sourceAsOfUtc || 'Source clock unavailable'}`, 'helper mono'));
    const wrap = element('div', null, 'table-scroll'), table = element('table'), head = element('tr');
    ['Instrument', 'Side', 'Direction', 'Quantity', 'Unit', 'Reference USD'].forEach(label => head.append(element('th', label))); const thead = element('thead'); thead.append(head); table.append(thead);
    const tbody = element('tbody'); for (const leg of row.signal.legs) { const tr = element('tr'); [leg.asset.instrumentId, leg.side ?? '—', leg.direction ?? '—', formatQuantity(leg.quantity), leg.quantityUnit ? `${leg.quantityUnit} ${leg.quantityAsset ?? ''}` : '—', formatPrice(leg.referencePrice)].forEach((value, index) => tr.append(element('td', value, index === 3 || index === 5 ? 'numeric' : ''))); tbody.append(tr); } table.append(tbody); wrap.append(table); detail.append(wrap);
  }
  const actions = element('div', null, 'entry-actions'), button = element('button', row.origin === 'local' ? 'Edit entry' : 'Copy to local Journal'); button.type = 'button'; button.addEventListener('click', () => showEditor(row.origin === 'local' ? row : { ...row, id: null, version: null })); actions.append(button); detail.append(actions);
}
function showEditor(row = null) {
  editing = row?.id ? row : null; entryRetryKey = crypto.randomUUID();
  $('editor').hidden = false; $('editor-title').textContent = editing ? 'Edit local entry' : 'New local entry';
  const notebooks = snapshot.notebooks.filter(row => row.origin === 'local');
  $('entry-notebook').replaceChildren(...notebooks.map(row => new Option(row.name, row.id)));
  if (row?.origin === 'local') $('entry-notebook').value = row.notebookId;
  $('entry-title').value = row?.title ?? ''; $('entry-body').value = row?.body ?? ''; $('entry-status').value = row?.status ?? 'watching'; $('entry-signal').value = row?.signal ? JSON.stringify(row.signal, null, 2) : '';
  $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('entry-title').focus();
}
$('journal-filter').addEventListener('change', renderEntries);
$('new-entry').addEventListener('click', () => showEditor()); $('cancel-edit').addEventListener('click', () => { $('editor').hidden = true; });
$('entry-form').addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => {
  let signal = null; if ($('entry-signal').value.trim()) { try { signal = JSON.parse($('entry-signal').value); } catch { throw new Error('Supply valid structured signal JSON, or leave it blank.'); } }
  const body = { notebookId: $('entry-notebook').value, title: $('entry-title').value, body: $('entry-body').value, status: $('entry-status').value, source: editing?.source ?? 'manual', observedAtUtc: editing?.observedAtUtc ?? null, instrument: editing?.instrument ?? null, venue: editing?.venue ?? null, signal, ...(editing ? { version: editing.version } : {}) };
  selected = await api(editing ? `/api/entries/${editing.id}` : '/api/entries', body, { 'Idempotency-Key': entryRetryKey }); $('editor').hidden = true; await load(); notify('Entry saved in your local Journal.', true);
}); });
$('notebook-form').addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => { await api('/api/notebooks', { name: $('notebook-name').value }); $('notebook-name').value = ''; await load({ forms: true }); notify('Local notebook created.', true); }); });
$('sync').addEventListener('click', event => action(event.currentTarget, async () => { const result = await api('/api/sync', {}); await load({ forms: true }); notify(result.complete ? 'Cloud Journal copied to this encrypted local workspace.' : result.reason, result.complete); }));
$('connect').addEventListener('click', event => action(event.currentTarget, async () => { notify('Complete sign-in and device consent in the browser. This may take a few minutes.'); await api('/api/connect', {}); await load({ forms: true }); notify('Flusso connected. Sync your cloud Journal when you are ready.', true); }));
$('disconnect').addEventListener('click', event => action(event.currentTarget, async () => { await api('/api/disconnect', {}); await load({ forms: true }); notify('Local credentials removed and Listener stopped. Revoke the device in Flusso settings to end server authorization.', true); }));
$('settings-form').addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => { await api('/api/settings', { version: snapshot.settings.version, enabled: $('enabled').checked, executionEnabled: $('execution').checked, source: $('source').value, notebookIds: [...$('watch-notebooks').selectedOptions].map(option => option.value), section: $('section').value, instructions: $('instructions').value, intervalSeconds: Number($('interval').value), accountId: snapshot.settings.accountId, authorizationId: snapshot.settings.authorizationId }); await load({ forms: true }); notify('Listener settings saved. Existing notes are a baseline when turning on.', true); }); });
$('check-now').addEventListener('click', event => action(event.currentTarget, async () => { await api('/api/check', {}); await load(); notify(snapshot.settings.enabled ? 'Check completed. See Activity and the latest check status.' : 'Turn the Listener on and save its settings before checking.'); }));
const policyNumbers = ['maxBaseQuantity', 'maxLimitPrice', 'maxOrderQuoteNotionalUsd', 'maxDailyQuoteNotionalUsd', 'maxLifetimeQuoteNotionalUsd', 'maxAdmittedRuns'];
$('policy-form').addEventListener('input', () => { previewId = null; $('policy-preview').hidden = true; });
$('policy-form').addEventListener('submit', event => { event.preventDefault(); action(event.submitter, async () => {
  const policy = { instrumentId: $('policy-instrument').value.trim(), marketFamily: 'spot_crypto', side: 'buy', orderType: 'limit', baseAsset: 'BTC', quoteAsset: 'USD', ...Object.fromEntries(policyNumbers.map(name => [name, Number($(name).value)])), startsAtUtc: new Date($('startsAtUtc').value + 'Z').toISOString(), expiresAtUtc: new Date($('expiresAtUtc').value + 'Z').toISOString(), slotPolicy: 'current_utc_hour' };
  const result = await api('/api/policy/preview', { accountId: $('policy-account').value.trim(), policy }); previewId = result.previewId; $('policy-preview-body').textContent = JSON.stringify(result.request?.body ?? result, null, 2); $('policy-preview').hidden = false; $('policy-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}); });
$('cancel-policy').addEventListener('click', () => { previewId = null; $('policy-preview').hidden = true; });
$('approve-policy').addEventListener('click', event => action(event.currentTarget, async () => { if (!previewId) throw new Error('Review a fresh exact policy first.'); const grant = await api('/api/policy/approve', { previewId }); previewId = null; $('policy-preview').hidden = true; await load({ forms: true }); notify(`Policy approved: ${grant.authorizationId}. Execution remains off until enabled in Listener settings.`, true); }));
function renderActivity() {
  $('activity-list').replaceChildren(...snapshot.activity.map(row => { const card = element('article', null, 'activity-card'); card.append(element('h2', row.title), element('span', `${row.decision} · ${row.status} · ${row.origin} · ${new Date(row.atUtc).toLocaleString()}`, 'meta'), element('p', row.reason)); return card; }));
  if (!snapshot.activity.length) $('activity-list').append(element('p', 'No observations processed yet.', 'empty'));
  $('attempts').textContent = snapshot.attempts.length ? JSON.stringify(snapshot.attempts, null, 2) : 'No execution attempts.';
}
async function initialize() {
  const fragment = location.hash.slice(1); history.replaceState(null, '', '/');
  if (fragment) { try { csrf = (await api('/api/bootstrap', {}, { Authorization: `Bearer ${fragment}` })).csrf; } catch { csrf = (await api('/api/session')).csrf; } }
  else csrf = (await api('/api/session')).csrf;
  await load({ forms: true });
  setInterval(() => { if (!document.hidden) load().catch(error => notify(error.message)); }, 10000);
}
initialize().catch(error => notify(error.message));
