import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { accountPresentation, updatePresentation, modelPresentation } from '../public/desktop-ui.mjs';

test('unchanged visible notices announce once, recover without focus theft, and announce a later recurrence', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function notify('), source.indexOf('async function api('));
  const frames = new Map(), nodes = new Map(); let sequence = 0, scrolls = 0;
  const get = id => { if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', className: '', getBoundingClientRect: () => ({ top: -40, bottom: 20 }), scrollIntoView() { scrolls++; } }); return nodes.get(id); };
  const focusedDraft = {}, context = { $: get, setText: (id, value) => { get(id).textContent = value; }, window: { innerHeight: 600 }, matchMedia: () => ({ matches: true }), document: { activeElement: focusedDraft, querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 62 }) }) },
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: id => frames.delete(id), clearTimeout() {}, setTimeout: () => 1 };
  runInNewContext(functions, context);
  const flush = () => { for (const [id, callback] of frames) { frames.delete(id); callback(); } };
  context.notifyPollFailure('Status read unavailable.'); flush();
  assert.equal(get('notice-alert').textContent, 'Status read unavailable.'); assert.equal(scrolls, 0, 'A background outage cannot move the reader or editor.');
  get('notice').getBoundingClientRect = () => ({ top: 20, bottom: 60 });
  context.notifyPollFailure('Status read unavailable.');
  assert.equal(frames.size, 0); assert.equal(get('notice-alert').textContent, 'Status read unavailable.'); assert.equal(scrolls, 0);
  get('notice').hidden = true; context.notifyPollFailure('Status read unavailable.');
  assert.equal(get('notice').hidden, true); assert.equal(frames.size, 0, 'Dismissing an ongoing polling outage keeps it dismissed.');
  assert.equal(get('refresh-status').hidden, false); assert.match(get('refresh-status').textContent, /Not updating.*last loaded state/);
  context.recoverPollNotice(); assert.equal(get('notice').hidden, true); assert.equal(get('notice-alert').textContent, '');
  assert.equal(get('refresh-status').hidden, true);
  context.notifyPollFailure('Status read unavailable.'); flush(); assert.equal(scrolls, 0);
  context.notify('Different save error.', false, true); flush(); assert.equal(get('notice-alert').textContent, 'Different save error.');
  assert.equal(scrolls, 1, 'An explicit action error still reveals itself without taking focus.');
  context.notifyPollFailure('Status read unavailable.'); assert.equal(frames.size, 0, 'The same polling outage does not replace a new action error.');
  context.recoverPollNotice(); assert.equal(get('notice').hidden, false, 'A successful poll must not clear an unrelated action error.');
  get('notice').hidden = true; context.notify('Different save error.', false, true); assert.equal(frames.size, 1, 'A dismissed notice may announce a recurrence.');
  assert.equal(context.document.activeElement, focusedDraft);
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.notice\{position:relative/);
  assert.doesNotMatch(css, /\.notice\{(?:[^}]*;)?(?:top|bottom):/);
});

test('a local service outage explains recovery without exposing raw browser fetch errors', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const api = source.slice(source.indexOf('async function api('), source.indexOf('async function action('));
  const context = { csrf: 'synthetic-csrf', fetch: async () => { throw new TypeError('Failed to fetch'); } };
  runInNewContext(api, context);
  await assert.rejects(context.api('/api/status'), /Journal lost its connection to its local service.*Retry/);
  context.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'The session expired. Reopen Journal.' }) });
  await assert.rejects(context.api('/api/status'), error => error.status === 403 && /The session expired/.test(error.message));
  context.fetch = async () => ({ ok: true, status: 201, json: async () => { throw new SyntaxError('Truncated reply.'); } });
  await assert.rejects(context.api('/api/notebooks', { name: 'Unconfirmed' }), error => error.name === 'Error' && /incomplete or unreadable response/.test(error.message) && error.status === undefined && !/Truncated reply/.test(error.message));
});

test('interface prose keeps numbers mono without making its whole sentence a data readout', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('function interfaceText('), source.indexOf('const reducedMotion'));
  const node = { dataset: { interfaceNumbers: 'true' }, textContent: '', replaceChildren(...children) { this.children = children; this.textContent = children.map(row => row.textContent).join(''); } };
  const context = { $: () => node, element: (tag, textContent, className) => ({ tag, textContent, className }), document: { createTextNode: textContent => ({ textContent }) } };
  runInNewContext(helper, context); const text = 'Checks 60 seconds after completion · v2 · first 2,000 UTF-16 text units'; context.setText('mixed', text);
  assert.equal(node.textContent, text); assert.deepEqual(node.children.filter(row => row.className === 'mono').map(row => row.textContent), ['60', '2', '2,000', '16']);
  const children = node.children; context.setText('mixed', text); assert.equal(node.children, children, 'Unchanged text keeps its DOM and selection.');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['last-check', 'model-input-coverage', 'model-verdict-context', 'model-verdict-coverage', 'process-count']) {
    const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0]; assert.match(tag, /data-interface-numbers="true"/); assert.doesNotMatch(tag, /class="[^"]*\bmono\b/);
  }
});

test('the Journal reader shows the current check before the preserved completed response with actual clocks', async () => {
  const ui = await import('../public/desktop-ui.mjs'), source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderDetail('), source.indexOf('// The editor takes'));
  const make = (tag, textContent = '', className = '') => ({ tag, textContent, className, dataset: {}, children: [], setAttribute() {}, addEventListener() {},
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    querySelector(selector) { const field = /\[data-entry-part="([^"]+)"\]/.exec(selector)?.[1] ?? null;
      const find = node => field && node.dataset.entryPart === field || !field && node.dataset.entryAction ? node : node.children.map(find).find(Boolean); return this.children.map(find).find(Boolean) ?? null; }, focus() {} });
  const detail = make('article'), keys = new Map(), recorded = '2026-10-23T10:01:05Z', completed = '2026-10-23T10:00:04Z';
  const row = { id: 'note', origin: 'local', title: 'Real research', body: 'Original note prose.', version: 2, status: 'reviewed',
    listener: { status: 'observed', decision: 'review', reason: 'Preserved accepted words.', version: 1, atUtc: '2026-10-23T10:00:00Z', completedAtUtc: completed },
    listenerCheck: { kind: 'research_check', status: 'waiting', reviewStatus: 'failed', version: 2, reason: 'Actual latest failure.', atUtc: recorded },
    handoff: { reason: 'The Listener is off. This note was already here when the Listener turned on.', context: { listenerEnabled: false } } };
  const context = { ...ui, selected: row, snapshot: { entries: [row] }, $: () => detail, element: make, pill: (text, tone) => make('span', text, tone),
    document: { activeElement: {}, createTextNode: text => make(null, text) }, renderMarkdown: (node, text, options) => { assert.equal(options.headingLevel, 4); node.textContent = text; }, notebookName: () => 'Research', renderKeys: keys,
    changed: (key, value) => { const next = JSON.stringify(value); if (keys.get(key) === next) return false; keys.set(key, next); return true; },
    formatCount: String, when: (value, seconds) => `${value}/${seconds ? 'seconds' : 'minutes'}`, TICKET_FENCE: /never-match/g };
  runInNewContext(render, context); context.renderDetail();
  const check = detail.children.find(node => node.dataset.entryPart === 'check'), live = detail.children.find(node => node.dataset.entryPart === 'live');
  assert.equal(detail.children[1].tag, 'section'); assert.equal(detail.children[1].children[0].tag, 'h3'); assert.equal(detail.children[1].children[0].textContent, 'Notes');
  assert.ok(detail.children.indexOf(check) < detail.children.indexOf(live));
  const all = node => [node, ...node.children.flatMap(all)];
  assert.ok(all(check).some(node => node.textContent === 'Latest research check')); assert.ok(all(check).some(node => node.textContent === 'Actual latest failure.'));
  assert.ok(all(check).some(node => node.tag === 'time' && node.textContent === `Recorded ${recorded}/seconds · v2` && node.className === 'detail-facts'));
  assert.ok(all(live).some(node => node.textContent === 'Earlier response')); assert.ok(all(live).some(node => node.textContent === 'Preserved accepted words.'));
  assert.ok(all(live).some(node => node.textContent === 'Preserved accepted words.' && node.className === 'verdict-reason'), 'The same published words use the Listener prose style.');
  const metadataLine = all(live).find(node => node.className === 'detail-meta');
  assert.ok(!metadataLine.children.some(node => node.textContent === 'Listener off'), 'Current Off state must not be presented as the historical response state.');
  const disclosure = all(live).find(node => node.tag === 'details' && node.children[0]?.textContent === 'Review details');
  assert.ok(disclosure); assert.ok(all(disclosure).some(node => node.textContent === `Current Listener context: ${row.handoff.reason}`), 'Current handoff context is explicitly distinct from the historical response.');
  assert.ok(all(live).some(node => node.tag === 'time' && node.textContent === `Completed ${completed}/seconds`));
  row.listener = { ...row.listener, completedAtUtc: null }; context.renderDetail();
  assert.ok(all(live).some(node => node.tag === 'time' && node.textContent === 'Recorded 2026-10-23T10:00:00Z/seconds'), 'Legacy records retain their recorded clock without an invented completion.');
  row.listener = { ...row.listener, version: row.version }; row.listenerCheck = null; context.renderDetail();
  const acceptedProse = all(live).find(node => node.className === 'verdict-reason'), noteProse = all(detail).find(node => node.className === 'note-body');
  assert.equal(detail.querySelector('[data-entry-part="response-title"]').textContent, 'Completed research response');
  row.listenerCheck = { kind: 'research_check', status: 'processing', activeReview: true, version: row.version, atUtc: recorded, reason: 'The local model is reading this note.' }; context.renderDetail();
  assert.equal(detail.querySelector('[data-entry-part="response-title"]').textContent, 'Earlier response');
  assert.equal(all(live).find(node => node.className === 'verdict-reason'), acceptedProse); assert.equal(all(detail).find(node => node.className === 'note-body'), noteProse);
  row.listenerCheck = { ...row.listenerCheck, status: 'waiting', reviewStatus: 'failed', completedAtUtc: recorded, reason: 'A later actual failure.' }; context.renderDetail();
  assert.equal(detail.querySelector('[data-entry-part="response-title"]').textContent, 'Earlier response');
  assert.equal(all(live).find(node => node.className === 'verdict-reason'), acceptedProse); assert.equal(all(detail).find(node => node.className === 'note-body'), noteProse);
});

test('entry saves lock the actual form handler until acceptance and an older refresh cannot unlock a newer save', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("$('entry-form').addEventListener('submit'"), source.indexOf("$('new-notebook').addEventListener"));
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const first = deferred(), refresh = deferred(), second = deferred(), requests = [], actions = [], errors = [];
  const controls = ['entry-notebook', 'entry-title', 'entry-body', 'entry-status', 'entry-signal'].map(id => ({ id, value: ({ 'entry-notebook': 'book', 'entry-title': 'Draft', 'entry-body': 'Exact submitted notes', 'entry-status': 'watching' })[id] ?? '', disabled: false }));
  const disabled = { disabled: true }, attributes = new Map(), nodes = Object.fromEntries(controls.map(control => [control.id, control]));
  const focus = { dataset: { rowKey: 'local:saved-note' }, focus() {} };
  let submit, closes = 0, renders = 0; const notices = [];
  nodes['entry-form'] = { elements: [...controls, disabled], setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key), addEventListener: (_event, callback) => { submit = callback; } };
  nodes['entry-list'] = { contains: () => false }; nodes['new-entry'] = focus;
  const context = {
    $: id => nodes[id], entrySaving: false, entryIntent: null, entrySavePendingMessage: 'The original save is unconfirmed.', renderEntrySaveState() {}, crypto: { randomUUID: () => 'new-entry-key' }, editing: null, entryRetryKey: 'original-retry-key', selected: null, snapshot: { entries: [{ id: 'saved-note', origin: 'cloud', version: 7 }] },
    document: { activeElement: focus, querySelector: () => focus },
    action: (_button, work) => { const promise = work().catch(error => errors.push(error.message)); actions.push(promise); },
    api: (path, body, headers) => { requests.push({ path, body, headers }); return requests.length === 1 ? first.promise : second.promise; },
    updateDraftProtection() {}, showSelectedEntry() {}, renderEntries() { renders++; }, notify: message => notices.push(message),
    closeEditor: () => { assert.equal(context.entrySaving, false); closes++; }, load: () => refresh.promise,
  };
  runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
  runInNewContext(handler, context);
  const event = { preventDefault() {} };
  submit(event);
  assert.equal(context.entrySaving, true); assert.equal(attributes.get('aria-busy'), 'true');
  assert.ok(nodes['entry-form'].elements.every(control => control.disabled));
  submit(event); assert.equal(requests.length, 1, 'A second submit cannot create another request.');
  assert.equal(requests[0].body.body, 'Exact submitted notes');
  first.resolve({ id: 'saved-note', version: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.entrySaving, false); assert.equal(attributes.has('aria-busy'), false); assert.equal(closes, 1);
  assert.equal(renders, 1, 'The confirmed saved row is rendered before the follow-up read.');
  assert.equal(context.snapshot.entries[0].id, 'saved-note'); assert.equal(context.snapshot.entries[0].origin, 'local');
  assert.equal(context.snapshot.entries[1].origin, 'cloud', 'An equal cloud ID must not be replaced by the local save.');
  assert.ok(controls.every(control => !control.disabled)); assert.equal(disabled.disabled, true);
  submit(event); assert.equal(context.entrySaving, true);
  refresh.reject(new Error('The list refresh is unavailable.')); await actions[0];
  assert.equal(context.snapshot.entries[0].version, 1); assert.ok(notices.some(message => message.includes('Entry saved, but the list could not refresh')));
  assert.equal(context.entrySaving, true, 'Finishing the older refresh must not release the newer form lock.');
  assert.ok(controls.every(control => control.disabled));
  second.reject(new Error('Save could not be confirmed.')); await actions[1];
  assert.equal(context.entrySaving, false); assert.equal(attributes.has('aria-busy'), false);
  assert.ok(controls.every(control => !control.disabled)); assert.equal(disabled.disabled, true);
  assert.equal(nodes['entry-body'].value, 'Exact submitted notes'); assert.equal(context.entryRetryKey, 'original-retry-key');
  assert.equal(errors.length, 1); assert.match(errors[0], /Save could not be confirmed.*original save is unconfirmed/);
});

test('historical and unrecorded result revisions are explicit without changing Listener result groups', async () => {
  const { listenerRevisionPresentation, entryCardPresentation, matchesResultFilter } = await import('../public/desktop-ui.mjs');
  const entry = { id: 'note', origin: 'local', version: 2, listener: { version: 1, status: 'observed', decision: 'review', reason: 'Original review.' } };
  assert.deepEqual(listenerRevisionPresentation(entry), { label: 'prior v1', note: 'This result is for entry v1. You are reading v2.' });
  assert.equal(entryCardPresentation(entry).outcome.label, 'review suggested · prior v1');
  assert.equal(matchesResultFilter(entry, 'decided'), true, 'The historical review remains available.');
  assert.equal(listenerRevisionPresentation({ ...entry, listener: { ...entry.listener, version: 2 } }), null);
  assert.equal(listenerRevisionPresentation({ ...entry, listener: { ...entry.listener, version: 3 } }).label, 'v3', 'A newer source result must not be mislabeled as prior.');
  for (const version of [undefined, null, '1', 0, -1, NaN, Infinity]) {
    const unknown = { ...entry, listener: { ...entry.listener, version } };
    assert.equal(listenerRevisionPresentation(unknown).label, 'revision unknown');
    assert.match(entryCardPresentation(unknown).outcome.label, /revision unknown/);
  }
  const ticket = { ...entry, ticket: { kind: 'orders' }, listener: { version: 1, status: 'submitted' } };
  assert.equal(entryCardPresentation(ticket).outcome.label, 'submitted · prior v1');
  assert.equal(matchesResultFilter(ticket, 'placed'), true);
  assert.equal(listenerRevisionPresentation({ ...entry, listener: null }), null);
});

test('only the exact validated research result on the desk is redundant with its latest preview', async () => {
  const { decisionShownInDesk, latestDecisions } = await import('../public/desktop-ui.mjs');
  const source = { entryId: 'research', origin: 'local', version: 2, atUtc: '2026-10-23T10:00:00Z' };
  const output = { ...source, status: 'complete', text: '{"decision":"review","reason":"Check the recorded source."}' };
  const published = { ...source, atUtc: '2026-10-23T10:00:04Z', decision: 'review', reason: 'Check the recorded source.' };
  const row = { ...source, id: 'research-v2', status: 'observed', decision: published.decision, reason: published.reason };
  assert.equal(decisionShownInDesk(row, output, published), true);
  assert.equal(decisionShownInDesk({ ...published, status: 'observed' }, output, published), true);
  for (const change of [{ entryId: 'other' }, { origin: 'cloud' }, { version: 1 }, { version: undefined }, { decision: 'ignore' }, { decision: 'ticket' }, { reason: published.reason + ' ' }, { atUtc: '2026-10-23T09:00:00Z' }, { atUtc: published.atUtc }, ...['waiting', 'unknown', 'pending', 'submitted', 'partial'].map(status => ({ status }))]) assert.equal(decisionShownInDesk({ ...row, ...change }, output, published), false);
  for (const change of [{ status: 'streaming' }, { status: 'stopped' }, { status: 'failed' }, { version: 1 }, { version: undefined }]) assert.equal(decisionShownInDesk(row, { ...output, ...change }, published), false);
  assert.equal(decisionShownInDesk(row, output, { ...published, version: undefined }), false);
  const earlier = { ...row, id: 'prior-run', atUtc: '2026-10-23T09:00:00Z' }, unknown = { ...row, id: 'unknown-result', status: 'unknown' }, ticket = { ...row, id: 'ticket-result', decision: 'ticket' };
  const activity = [row, earlier, unknown, ticket], before = JSON.stringify(activity);
  const preview = latestDecisions(activity, published, { limit: null }).filter(item => !decisionShownInDesk(item, output, published)).slice(0, 5);
  assert.deepEqual(new Set(preview.map(item => item.id)), new Set([earlier.id, unknown.id, ticket.id]));
  assert.equal(latestDecisions(activity, published, { limit: null }).length, 4, 'Full Activity still retains every source record.');
  assert.equal(JSON.stringify(activity), before);
});

test('the existing entry Save and Cancel controls sit in its heading and the output retains an accessible region name', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const formStart = html.indexOf('<form id="entry-form">'), form = html.slice(formStart, html.indexOf('</form>', formStart));
  const heading = form.slice(0, form.indexOf('<label class="title-field">'));
  assert.match(heading, /class="editor-head"/); assert.match(heading, /id="cancel-edit"/); assert.match(heading, /type="submit" class="primary" id="entry-save" aria-describedby="entry-save-status">Save<\/button>/);
  assert.equal((form.match(/id="cancel-edit"/g) ?? []).length, 1); assert.equal((form.match(/>Save<\/button>/g) ?? []).length, 1);
  assert.match(html, /<h2 id="model-output-heading" class="sr-only"/); assert.match(html, /<h3 id="model-verdict-label"/);
  assert.match(html, /aria-labelledby="model-output-heading"/); assert.doesNotMatch(html, /Accepted local decision/);
  assert.match(html, /id="process-state" class="process-state" tabindex="-1"/);
  assert.match(html, /Local model response · format checked/);
  assert.ok(html.indexOf('id="model-raw-toggle"') < html.indexOf('id="model-verdict"'), 'Current raw controls precede the separately attributed earlier response.');
  assert.ok(html.indexOf('id="model-output-note"') < html.indexOf('id="model-verdict"'));
  const native = html.slice(html.indexOf('id="native-controls"'), html.indexOf('</section>', html.indexOf('id="native-controls"')));
  assert.match(native, /Closing this window keeps the Listener running/); assert.match(native, /Quit Journal and stop Listener/);
  assert.ok(html.indexOf('<details class="ops-log">') < html.indexOf('<section class="decisions-panel"'), 'Operations remains before the changing preview panel.');
});

test('a hidden verdict returns keyboard focus to visible process state and keyed source metadata survives token updates', async () => {
  const { processingPresentation, modelOutputPresentation, completedModelPresentation, modelCoverageLabel, latestCheckPresentation, reviewFocusPresentation, completionAnnouncement } = await import('../public/desktop-ui.mjs');
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const focusRender = source.slice(source.indexOf('function renderReviewFocus('), source.indexOf('function positionResponseTools('));
  const render = focusRender + source.slice(source.indexOf('function renderProcess()'), source.indexOf('function renderDecisions()'));
  const document = { activeElement: { id: 'model-output' } }, nodes = new Map(), keys = new Map(); let sourceButtons = 0;
  const node = (id, textContent = '') => ({ id, textContent, dataset: {}, classList: { toggle() {} }, children: [], scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    replaceChildren(...children) { this.children = children; },
    querySelector(tag) { return this.children.find(child => child.id === tag) ?? null; },
    contains(target) { return target?.id === id || this.children.includes(target); },
    focus(options) { document.activeElement = this; this.focusOptions = options; }, setAttribute() {},
  });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); };
  const context = {
    document, $: get, snapshot: { settings: { enabled: true }, entries: [], listener: { busy: true, modelOutput: null, events: [] } },
    processingPresentation, modelOutputPresentation, completedModelPresentation, modelCoverageLabel, latestCheckPresentation, reviewFocusPresentation, completionAnnouncement, streamDisconnected: false, rawOpen: false, lastCompletionKey: null, completionFrame: null,
    setText: (id, value) => { get(id).textContent = value; }, interfaceText: (target, value) => { target.textContent = value; }, growText: (target, value) => { target.textContent = value; },
    changed: (key, value) => { const serialized = JSON.stringify(value); if (keys.get(key) === serialized) return false; keys.set(key, serialized); return true; },
    element: (tag, content) => node(tag, content), sourceButton: (_row, title) => node(`source-${++sourceButtons}`, title), when: value => value,
    renderOutputText() {}, positionResponseTools() {}, decisionItems: () => [], reconcileRows() {}, cancelAnimationFrame() {}, requestAnimationFrame: callback => { callback(); return 1; },
  };
  runInNewContext(render, context); context.renderProcess();
  assert.equal(document.activeElement, get('process-state')); assert.equal(get('process-state').textContent, 'Reading');
  assert.equal(get('model-verdict').hidden, true); assert.equal(document.activeElement.focusOptions, undefined, 'The browser may reveal the newly focused visible state.');
  const output = { entryId: 'research', origin: 'local', title: 'Source research', version: 2, coverage: { bodyUnits: 2000, totalBodyUnits: 2400, bodyTruncated: true, unit: 'UTF-16' }, atUtc: '2026-10-23T10:00:00Z', status: 'streaming', text: '{"decision":"review","reason":"Public model' };
  context.snapshot.entries = [{ id: output.entryId, origin: output.origin, version: output.version }]; context.snapshot.listener.modelOutput = output;
  context.renderProcess();
  assert.equal(get('model-input-coverage').textContent, 'Note excerpt supplied', 'Actual public output proves the request progressed beyond preparation.');
  assert.match(get('model-input-coverage-detail').textContent, /^Excerpt only:/);
  const metadata = get('model-output-source'), button = metadata.children[1]; button.focus();
  assert.equal(metadata.children[0].textContent, 'Source note'); assert.equal(metadata.children[2].textContent, `Check started ${output.atUtc}`); assert.equal(metadata.children[2].dateTime, output.atUtc);
  output.text += ' wording.'; context.renderProcess();
  assert.equal(metadata.children[1], button); assert.equal(document.activeElement, button); assert.equal(sourceButtons, 1);
  context.snapshot.listener.busy = false; output.status = 'complete'; output.text = '{"decision":"review","reason":"Public model wording."}';
  context.snapshot.listener.lastModelOutput = { ...output, decision: 'review', reason: 'Public model wording.', atUtc: '2026-10-23T10:00:04Z' };
  context.renderProcess();
  assert.equal(get('model-verdict-kicker').textContent, 'Local model response · format checked');
  assert.equal(get('model-verdict-reason').textContent, 'Public model wording.'); assert.equal(metadata.children[1], button); assert.equal(sourceButtons, 2);
  assert.equal(metadata.hidden, true, 'The completed card owns this run’s source metadata.');
  assert.equal(document.activeElement, get('model-verdict-label'), 'Focus leaves the now-hidden duplicate source row.');
  const acceptedReason = get('model-verdict-reason'), acceptedSource = get('model-verdict-source').children[1];
  acceptedReason.focus(); context.snapshot.listener.busy = true;
  context.snapshot.listener.modelReview = { id: 2, status: 'running' };
  context.snapshot.listener.modelOutput = { ...output, checkId: 2, atUtc: '2026-10-23T10:01:00Z', status: 'streaming', text: '{"decision":"review","reason":"Next actual words' };
  context.renderProcess();
  assert.equal(get('model-verdict').hidden, false); assert.equal(get('model-verdict-reason'), acceptedReason);
  assert.equal(acceptedReason.textContent, 'Public model wording.'); assert.equal(document.activeElement, acceptedReason);
  assert.equal(get('model-verdict-source').children[1], acceptedSource);
  assert.equal(get('model-draft-reason').textContent, 'Next actual words');
  assert.equal(get('model-draft-label').textContent, 'Live model response');
  assert.equal(get('model-draft-head').className, 'sr-only'); assert.equal(get('model-output-status').hidden, true);
  assert.equal(metadata.hidden, false, 'A new stream shows its own source separately from the completed card.');
  assert.match(get('model-verdict-kicker').textContent, /^Earlier/);
  const lastReported = JSON.stringify(context.snapshot.listener); context.streamDisconnected = true; context.renderProcess();
  assert.equal(get('review-desk').dataset.state, 'disconnected'); assert.equal(get('review-desk').dataset.live, 'false');
  assert.equal(get('process-state').textContent, 'Reconnecting'); assert.equal(get('process-stage').hidden, true);
  assert.match(get('process-message').textContent, /last reported state.*may still be running/);
  assert.equal(JSON.stringify(context.snapshot.listener), lastReported, 'A disconnected view never aborts or fabricates a terminal model state.');
  assert.equal(get('model-verdict-reason').textContent, 'Public model wording.'); context.streamDisconnected = false; context.renderProcess();
  acceptedSource.focus(); context.snapshot.listener.busy = false;
  context.snapshot.listener.modelOutput.status = 'complete';
  context.snapshot.listener.lastModelOutput = { ...context.snapshot.listener.modelOutput, decision: 'review', reason: 'Second completed reason.', atUtc: '2026-10-23T10:01:04Z' };
  context.renderProcess();
  assert.equal(get('model-verdict-source').children[1], acceptedSource, 'A new completion clock cannot replace the same source button.');
  assert.equal(document.activeElement, acceptedSource); assert.equal(sourceButtons, 3, 'Only the separate new-stream metadata created a source button.');
  assert.equal(get('model-verdict-source').querySelector('time').textContent, 'Completed 2026-10-23T10:01:04Z');
  assert.equal(get('model-verdict-source').querySelector('time').dateTime, '2026-10-23T10:01:04Z');
  const reasonNode = get('model-verdict-reason'), focusSummary = get('model-verdict-focus-summary');
  get('model-verdict-focus').open = true; focusSummary.focus();
  context.snapshot.listener.lastModelOutput.focus = { kind: 'custom', text: 'Look at the exact source timestamp.' };
  context.renderProcess();
  assert.equal(get('model-verdict-reason'), reasonNode); assert.equal(get('model-verdict-source').children[1], acceptedSource);
  assert.equal(document.activeElement, focusSummary); assert.equal(get('model-verdict-focus').open, true);
  assert.equal(get('model-verdict-focus-text').textContent, 'Look at the exact source timestamp.');
  assert.equal(get('model-verdict-focus-summary').textContent, 'Review details');
  assert.equal(get('model-verdict-focus-label').textContent, 'Review focus: Custom');
  get('model-output').focus(); context.rawOpen = true;
  context.snapshot.listener.busy = true; context.snapshot.listener.modelReview = { id: 3, status: 'running' };
  context.snapshot.listener.modelOutput = { ...context.snapshot.listener.modelOutput, checkId: 3, status: 'streaming', text: '' };
  context.renderProcess(); assert.equal(document.activeElement, get('process-state'));
  assert.equal(get('model-input-coverage').textContent, 'Note excerpt prepared');
  assert.match(get('model-input-coverage-detail').textContent, /^Prepared excerpt:/);
  assert.doesNotMatch(get('model-input-coverage').textContent, /supplied|sent to the model/);
  assert.equal(get('model-output').hidden, true); assert.equal(document.activeElement.focusOptions, undefined);
  acceptedSource.focus(); context.snapshot.listener.lastModelOutput = { ...context.snapshot.listener.lastModelOutput, entryId: 'different-source', title: 'Different source' };
  context.renderProcess();
  assert.equal(document.activeElement, get('model-verdict-label'), 'A genuinely different source transfers focus before replacing its metadata.');
  context.snapshot.listener.modelOutput = null; context.snapshot.listener.busy = false;
  context.snapshot.listener.lastModelOutput = { ...context.snapshot.listener.lastModelOutput, completionKnown: false };
  context.renderProcess();
  assert.equal(get('model-output-empty').hidden, true, 'Restored completed output never says nothing has been reviewed.');
  assert.match(get('model-verdict-source').querySelector('time').textContent, /^Recorded /, 'Legacy start clocks are not invented completion clocks.');
  context.snapshot.listener.lastModelOutput = null;
  context.snapshot.listener.modelReview = { id: 'recovered', status: 'failed' }; context.snapshot.listener.modelRecovery = { checkId: 'recovered' };
  context.snapshot.listener.modelOutput = { ...output, checkId: 'recovered', status: 'failed' }; context.renderProcess();
  assert.equal(get('model-output-status').textContent, 'Check failed', 'Recovery cannot relabel an actual failed response as stopped or unfinished.');
  context.snapshot.listener.modelOutput.status = 'stopped'; context.renderProcess(); assert.equal(get('model-output-status').textContent, 'Check unfinished');
  context.snapshot.settings.enabled = false;
  context.snapshot.listener.modelRecovery = null; context.snapshot.listener.modelOutput = null;
  context.snapshot.listener.modelReview = { id: 'latest-failed', status: 'failed', restored: true, startedAtUtc: '2026-10-23T10:02:00Z', completedAtUtc: '2026-10-23T10:02:04Z', reason: 'The actual latest model failure.' };
  context.snapshot.listener.lastModelOutput = { ...output, checkId: 'earlier-accepted', status: 'complete', decision: 'review', reason: 'Earlier actual model words.', atUtc: '2026-10-23T10:00:04Z' };
  context.renderProcess();
  assert.equal(get('process-state').textContent, 'Off'); assert.equal(get('latest-check').hidden, false);
  assert.equal(get('latest-check-label').textContent, 'Check failed'); assert.equal(get('latest-check-reason').textContent, 'The actual latest model failure.');
  assert.equal(get('latest-check-time').textContent, 'Finished 2026-10-23T10:02:04Z');
  assert.equal(get('model-verdict-reason').textContent, 'Earlier actual model words.'); assert.match(get('model-verdict-kicker').textContent, /^Earlier/);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="latest-check"') < html.indexOf('id="model-verdict"'), 'The latest outcome precedes the retained earlier response, including while Off.');
  assert.equal(context.snapshot.listener.lastError, undefined, 'A historical failure is not invented as an active model error.');
  for (const [status, restored] of [['failed', false], ['failed', true], ['stopped', false], ['stopped', true], ['skipped', false]]) {
    context.snapshot.settings.enabled = true;
    const reason = `Exact ${status} outcome.`;
    context.snapshot.listener.modelReview = { id: `terminal-${status}`, status, restored, reason, completedAtUtc: '2026-10-23T10:03:04Z' };
    context.snapshot.listener.lastError = status === 'failed' && !restored ? reason : null;
    context.snapshot.listener.processing = status === 'stopped' && !restored ? { stage: 'paused', message: 'The check paused after a settings change.' } : null;
    context.renderProcess();
    assert.equal(get('process-state').textContent, 'On'); assert.equal(get('process-message').hidden, true); assert.equal(get('process-message').textContent, '');
    assert.equal(get('review-desk').dataset.state, 'ready', 'Current On styling does not inherit the historical warning tone.');
    assert.equal(get('latest-check').hidden, false); assert.equal(get('latest-check-reason').textContent, reason);
    assert.equal(get('latest-check-time').textContent, 'Finished 2026-10-23T10:03:04Z'); assert.equal(get('model-verdict-reason').textContent, 'Earlier actual model words.');
  }
  context.snapshot.listener.busy = true; context.snapshot.listener.modelReview = { id: 'new-running-check', status: 'running' }; context.snapshot.listener.lastError = null;
  context.snapshot.listener.processing = { stage: 'model', message: 'The local model is reading this note.' }; context.renderProcess();
  assert.equal(get('process-state').textContent, 'Reading'); assert.equal(get('latest-check').hidden, true);

});

test('last-check summary uses only retained terminal evidence and distinguishes finished, recorded and unavailable clocks', async () => {
  const { latestCheckPresentation } = await import('../public/desktop-ui.mjs');
  const review = { id: 'check', status: 'failed', reason: 'The actual recorded failure.', startedAtUtc: '2026-10-23T10:00:00Z', completedAtUtc: '2026-10-23T10:00:03Z' };
  const listener = { busy: false, modelReview: review }, before = JSON.stringify(listener);
  assert.deepEqual(latestCheckPresentation(listener), { label: 'Check failed', reason: review.reason, clock: review.completedAtUtc, clockLabel: 'Finished' });
  assert.equal(latestCheckPresentation({ ...listener, busy: true }), null);
  assert.deepEqual(latestCheckPresentation({ modelReview: { ...review, status: 'stopped', completedAtUtc: null } }), { label: 'Check unfinished', reason: review.reason, clock: review.startedAtUtc, clockLabel: 'Recorded' });
  assert.equal(latestCheckPresentation({ modelReview: { status: 'failed' } }).clock, null);
  assert.equal(latestCheckPresentation({ modelReview: { ...review, status: 'complete' } }), null);
  assert.equal(JSON.stringify(listener), before);
});

test('native menu uses Electron zoom and window roles without changing the existing close or quit handlers', async () => {
  const source = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const menu = source.slice(source.indexOf('  Menu.setApplicationMenu('), source.indexOf('  await window.loadURL'));
  let template; const context = { Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { template = value; } }, showJournal() {}, updates: {}, changed() {}, app: {} };
  runInNewContext(menu, context);
  const roles = template.flatMap(item => [item.role, ...(item.submenu ?? []).map(child => child.role)]).filter(Boolean);
  for (const role of ['editMenu', 'resetZoom', 'zoomIn', 'zoomOut', 'windowMenu', 'minimize', 'zoom', 'close']) assert.ok(roles.includes(role));
  assert.match(source, /window\.on\('close', event => \{ if \(!quitting\) \{ event\.preventDefault\(\); window\.hide\(\); \} \}\)/);
  assert.ok(template[0].submenu.some(item => item.label === 'Quit Journal and stop Listener'));
});

test('output heading precedes its outcome and the fixed library trigger opens an existing native dialog', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="model-output-heading"') < html.indexOf('id="latest-check"'));
  assert.equal((html.match(/id="model-output-heading"/g) ?? []).length, 1);
  const journal = html.slice(html.indexOf('id="view-journal"'), html.indexOf('id="view-listener"'));
  const header = journal.slice(0, journal.indexOf('</header>'));
  assert.match(header, /<button id="new-notebook"[^>]*aria-haspopup="dialog" aria-controls="notebook-dialog"/);
  assert.equal((html.match(/id="notebook-form"/g) ?? []).length, 1);
  assert.match(html, /<dialog id="notebook-dialog" class="discard-dialog notebook-dialog" aria-labelledby="notebook-dialog-title">/);
  assert.match(html, /<a class="brand" href="\/" aria-label="Flusso Journal home">/);
  const pane = journal.slice(journal.indexOf('class="entry-pane"'), journal.indexOf('<article class="entry-detail"'));
  assert.doesNotMatch(pane, /notebook-form/);
});

test('native notebook creation retains failures in the dialog and a confirmed save survives refresh failure', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const handlers = source.slice(source.indexOf('let notebookSaving'), source.indexOf("$('sync').addEventListener"));
  for (const mode of ['refused', 'refresh-failed', 'accepted']) {
    const callbacks = new Map(), nodes = new Map(), jobs = [], notices = []; let requests = 0, release;
    const pending = new Promise(resolve => { release = resolve; });
    const get = id => { if (!nodes.has(id)) nodes.set(id, { value: id === 'notebook-name' ? 'Exact new notebook' : '', hidden: true, disabled: false,
      addEventListener: (event, callback) => callbacks.set(`${id}:${event}`, callback), setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; }, showModal() { this.open = true; }, close() { this.open = false; } }); return nodes.get(id); };
    const context = { updateDraftProtection() {}, $: get, document: { activeElement: {}, body: {} }, crypto: { randomUUID: () => 'stable-notebook-key' }, formDirty: false, api: async (_path, input) => { requests++; assert.equal(input.name, 'Exact new notebook'); await pending; if (mode === 'refused') throw Object.assign(new Error('Actual create refusal.'), { status: 400 }); return {}; },
      load: async () => { if (mode === 'refresh-failed') throw new Error('Actual read failure.'); }, notify: (message, success) => notices.push({ message, success }),
      action: (_button, work) => jobs.push(work()) };
    runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
    runInNewContext(handlers, context); callbacks.get('new-notebook:click')(); assert.equal(get('notebook-dialog').open, true);
    callbacks.get('notebook-form:submit')({ preventDefault() {}, submitter: {} }); assert.equal(get('notebook-name').disabled, true); release(); await jobs[0];
    assert.equal(get('notebook-name').disabled, false); assert.equal(requests, 1);
    if (mode === 'refused') {
      assert.equal(get('notebook-dialog').open, true); assert.equal(get('notebook-name').value, 'Exact new notebook');
      assert.equal(get('notebook-error').hidden, false); assert.equal(get('notebook-error').textContent, 'Actual create refusal.'); assert.equal(notices.length, 0);
    } else {
      assert.equal(get('notebook-dialog').open, false); assert.equal(get('notebook-name').value, ''); assert.match(notices[0].message, /^Notebook added/);
      if (mode === 'refresh-failed') assert.match(notices[0].message, /list could not refresh/);
    }
    callbacks.get('new-notebook:click')(); callbacks.get('cancel-notebook:click')(); assert.equal(get('notebook-dialog').open, false);
  }
});

test('research outcome vocabulary is consistent and Finished is used only with an actual terminal clock', async () => {
  const { activityStatus, activityMetadata, modelOutputPresentation, latestCheckPresentation, completionAnnouncement } = await import('../public/desktop-ui.mjs');
  const failure = { kind: 'research_check', status: 'waiting', reviewStatus: 'failed', version: 2, atUtc: '2026-10-23T10:00:00Z', completedAtUtc: '2026-10-23T10:00:03Z' };
  assert.equal(activityStatus(failure).label, 'check failed'); assert.equal(modelOutputPresentation({ status: 'failed' }).label, 'Check failed');
  assert.equal(latestCheckPresentation({ modelReview: { status: 'failed', completedAtUtc: failure.completedAtUtc } }).label, 'Check failed');
  assert.equal(activityMetadata(failure).clockLabel, 'Finished'); assert.equal(activityMetadata(failure).clock, failure.completedAtUtc);
  assert.equal(activityMetadata({ ...failure, completedAtUtc: null }).clockLabel, 'Recorded'); assert.equal(activityMetadata({ ...failure, completedAtUtc: null }).clock, failure.atUtc);
  const running = { ...failure, status: 'processing', reviewStatus: null, completedAtUtc: null, activeReview: true };
  assert.equal(activityMetadata(running).clockLabel, 'Started'); assert.equal(activityMetadata({ ...running, activeReview: false }).clockLabel, 'Recorded');
  assert.match(completionAnnouncement(modelOutputPresentation({ status: 'failed' }), { status: 'failed' }, null, 'Actual model failure.').message, /^Check failed\. Actual model failure\./);
});

test('forced colors preserves explicit checked and selected control outlines with system colors', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const forced = css.slice(css.indexOf('@media(forced-colors:active)'), css.indexOf('\n}', css.indexOf('@media(forced-colors:active)')) + 2);
  for (const selector of ['.switch-track', '.switch input:checked+.switch-track', '.segmented>label input:checked+span', '.chips input:checked+span', '.entry-card.selected', '.theme-option[aria-checked=true]']) assert.ok(forced.includes(selector));
  assert.match(forced, /outline:2px solid Highlight/); assert.match(forced, /background:HighlightText/); assert.match(forced, /border:1px solid ButtonText/);
});

test('a saving clean entry cannot be replaced, closed or navigated away from', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const boundaries = [['function showEditor(', '// Picking another entry'], ['function leaveEditor()', 'function closeEditor('], ['function closeEditor(', 'function insertTicket('], ['function switchView(', "\ndocument.querySelectorAll('[data-view]')"]];
  const guards = boundaries.map(([start, end]) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))).join('\n');
  const notices = [], context = { entrySaving: true, entryIntent: null, editorDirty: () => false, notify: message => notices.push(message), $() { throw new Error('A saving editor must not be replaced or hidden.'); } };
  runInNewContext(guards, context);
  context.showEditor(); assert.equal(context.leaveEditor(), false); context.closeEditor(); context.switchView('activity');
  assert.equal(notices.length, 4); assert.ok(notices.every(message => message.includes('still saving')));
});

test('raw tools follow their accepted decision, precede an earlier decision during streaming, and retain keyboard focus and identity', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('function positionResponseTools('), source.indexOf('function renderProcess()'));
  const raw = { id: 'raw', focus() { document.activeElement = raw; } }, document = { activeElement: raw };
  const tools = { contains: node => node === raw }, verdict = {};
  let order = [tools, verdict];
  Object.defineProperty(tools, 'nextElementSibling', { get: () => order[order.indexOf(tools) + 1] });
  Object.defineProperty(verdict, 'nextElementSibling', { get: () => order[order.indexOf(verdict) + 1] });
  const move = after => { order = order.filter(node => node !== tools); order.splice(order.indexOf(verdict) + Number(after), 0, tools); document.activeElement = null; };
  verdict.after = node => { assert.equal(node, tools); move(true); }; verdict.before = node => { assert.equal(node, tools); move(false); };
  const context = { document, $: id => id === 'model-response-tools' ? tools : verdict };
  runInNewContext(helper, context); context.positionResponseTools(true);
  assert.deepEqual(order, [verdict, tools]); assert.equal(document.activeElement, raw);
  context.positionResponseTools(false); assert.deepEqual(order, [tools, verdict]); assert.equal(document.activeElement, raw);
  context.positionResponseTools(false); assert.equal(document.activeElement, raw, 'An already correct layout does not move focused content.');
});

test('initialization stays inert through delayed/failing status, retries once, and starts only one successful existing poller', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const boot = source.slice(source.indexOf('let initializing ='), source.indexOf("$('retry-initialize').addEventListener"));
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="workspace" inert aria-busy="true"/); assert.match(html, /id="process-state"[^>]*>Loading/);
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, { inert: id === 'workspace', setAttribute(key, value) { this[key] = value; } }); return nodes.get(id); };
  let reject, streams = 0, polls = 0, loads = 0;
  const firstRead = new Promise((_yes, no) => { reject = no; });
  const context = { location: { hash: '#synthetic-bootstrap' }, history: { replaceState() {} }, $: get, api: async () => ({ csrf: 'synthetic-csrf' }),
    load: () => ++loads === 1 ? firstRead : Promise.resolve(), streamListener: () => { streams++; }, setInterval: () => { polls++; }, setText: (id, text) => { get(id).textContent = text; } };
  runInNewContext(boot, context); const loading = context.startWorkspace(); await Promise.resolve(); await context.startWorkspace();
  assert.equal(get('workspace').inert, true); assert.equal(loads, 1); assert.equal(polls, 0);
  reject(new Error('Synthetic status read failure.')); await loading;
  assert.equal(get('workspace').inert, true); assert.equal(get('retry-initialize').hidden, false); assert.equal(get('startup').role, 'alert');
  await context.startWorkspace(); assert.equal(get('workspace').inert, false); assert.equal(get('startup').hidden, true); assert.equal(polls, 1); assert.equal(streams, 1);
  await context.startWorkspace(); assert.equal(polls, 1); assert.equal(loads, 2);
});

test('separate empty ticket insertions have distinct durable IDs even in the same minute; existing tickets are not rewritten', async () => {
  const { ticketDraft } = await import('../public/desktop-ui.mjs');
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const insert = source.slice(source.indexOf('function insertTicket('), source.indexOf("$('insert-ticket').addEventListener"));
  let sequence = 0; const body = { value: '', focus() {} }, status = {};
  const context = { entryIntent: null, crypto: { randomUUID: () => `unique-${++sequence}` }, ticketDraft, $: id => id === 'entry-body' ? body : status,
    TICKET_FENCE: /^(```|~~~)[ \t]*flusso-(?:orders|close)[ \t]*\n[\s\S]*?^\1[ \t]*$/gm, updateDraftProtection() {}, notify() {} };
  runInNewContext(insert, context);
  context.insertTicket(); const first = body.value; assert.match(first, /ticket-unique-1/); assert.match(first, /"orders": \[\]/);
  context.insertTicket(true); assert.equal(body.value, first, 'Clicking again preserves the inserted identity and draft.');
  body.value = ''; context.insertTicket(true); assert.match(body.value, /ticket-unique-3/); assert.match(body.value, /"positionIds": \[\]/);
  assert.notEqual(JSON.parse(first.split('\n').slice(1, -2).join('\n')).id, JSON.parse(body.value.split('\n').slice(1, -2).join('\n')).id);
});

test('completed responses distinguish earlier checks, known revisions and canonical scope without guessing eligibility', async () => {
  const { completedModelPresentation, modelCoverageLabel, processingPresentation, modelOutputPresentation } = await import('../public/desktop-ui.mjs');
  const published = { entryId: 'source', origin: 'local', version: 1, checkId: 7, decision: 'review', reason: 'Actual unchanged reason.', atUtc: '2026-10-23T12:00:00Z' };
  const source = { id: 'source', origin: 'local', version: 1, handoff: { context: { inScope: true } } };
  const listener = { lastModelOutput: published, modelReview: { id: 8, status: 'not_run', reason: 'No model was run.' } };
  const earlier = completedModelPresentation(listener, [source]);
  assert.equal(earlier.earlier, true); assert.equal(earlier.reason, published.reason); assert.match(earlier.context, /v1 · Same note revision · Current: Matches selected filters/);
  const changed = completedModelPresentation({ lastModelOutput: published }, [{ ...source, version: 2, handoff: { context: { inScope: false } } }]);
  assert.equal(changed.earlier, true); assert.match(changed.context, /v1 · Current note is v2 · Current: Outside selected filters/);
  const closed = completedModelPresentation(listener, [{ ...source, status: 'closed', version: 2 }]);
  assert.match(closed.context, /Current note is v2 · Current: Closed note · Matches selected filters/);
  assert.match(completedModelPresentation(listener, []).context, /Source not loaded/);
  assert.match(completedModelPresentation({ lastModelOutput: { ...published, version: null } }, [source]).context, /revision unknown/);
  assert.equal(processingPresentation(listener, true).title, 'No model run');
  const excerpt = { bodyUnits: 2000, totalBodyUnits: 2100, bodyTruncated: true, unit: 'UTF-16' }, full = { bodyUnits: 40, totalBodyUnits: 40, bodyTruncated: false, unit: 'UTF-16' };
  assert.equal(modelCoverageLabel(excerpt, { received: true }), 'Note excerpt supplied'); assert.equal(modelCoverageLabel(excerpt), 'Note excerpt prepared');
  assert.equal(modelCoverageLabel(full, { received: true }), 'Full note supplied'); assert.equal(modelCoverageLabel(full), 'Full note prepared');
  assert.match(modelCoverageLabel(excerpt, { received: true, detail: true }), /first 2,000 of 2,100 UTF-16 text units\. The rest was not sent to the model\./);
  assert.match(modelCoverageLabel(full, { received: true, detail: true }), /Full note body supplied · 40 UTF-16 text units/);
  assert.equal(completedModelPresentation({ lastModelOutput: published }, [source]).earlier, false, 'Restoring the latest accepted result alone is not a newer attempt.');
  assert.equal(modelCoverageLabel(null), 'Review coverage unavailable');
  const output = { ...published, text: '{}', status: 'complete', atUtc: '2026-10-23T11:59:59Z' };
  assert.equal(modelOutputPresentation(output, { ...published, version: 2 }).accepted, false);
  assert.equal(modelOutputPresentation(output, { ...published, checkId: 8 }).accepted, false);
});

test('only the exact displayed completed check is redundant during a later stream; other revisions and unfinished checks remain', async () => {
  const { decisionShownInDesk, listenerRevisionPresentation } = await import('../public/desktop-ui.mjs');
  const row = { id: 'accepted', entryId: 'source', origin: 'local', version: 1, checkId: 'actual-check', decision: 'review', reason: 'Actual reason.', status: 'observed', atUtc: '2026-10-23T12:00:00Z' };
  const published = { ...row, activityId: row.id, atUtc: '2026-10-23T12:00:03Z' };
  const stream = { ...row, checkId: 'next-check', status: 'streaming', atUtc: '2026-10-23T12:01:00Z' };
  assert.equal(decisionShownInDesk(row, stream, published, { completed: true }), true);
  for (const changed of [{ checkId: 'different-check' }, { id: 'different-record' }, { version: 2 }, { status: 'waiting' }, { reason: 'Different actual reason.' }]) {
    assert.equal(decisionShownInDesk({ ...row, ...changed }, stream, published, { completed: true }), false);
  }
  assert.equal(decisionShownInDesk(row, stream, published), false, 'A hidden completed response cannot suppress a history row.');
  assert.equal(listenerRevisionPresentation({ version: 3, listener: row }).label, 'prior v1');
});

test('only the exact current failed research check already described on the desk is redundant', async () => {
  const { decisionShownInDesk, latestDecisions } = await import('../public/desktop-ui.mjs');
  const output = { status: 'failed', activityId: 'current-progress', checkId: 'current-check', entryId: 'note', origin: 'local', version: 3 };
  const row = { id: output.activityId, checkId: output.checkId, entryId: output.entryId, origin: output.origin, version: 3, kind: 'research_check', status: 'waiting', reviewStatus: 'failed', reason: 'The local model stopped.' };
  const failure = { checkId: output.checkId, reason: row.reason };
  assert.equal(decisionShownInDesk(row, output, null, { failure }), true);
  for (const change of [{ id: 'different-record' }, { checkId: 'earlier-check' }, { version: 2 }, { version: undefined }, { entryId: 'other' }, { origin: 'cloud' }, { reason: row.reason + ' ' }, { reviewStatus: 'stopped' }, { kind: 'orders' }]) {
    assert.equal(decisionShownInDesk({ ...row, ...change }, output, null, { failure }), false);
  }
  assert.equal(decisionShownInDesk(row, output, null), false, 'An error not currently displayed cannot suppress history.');
  assert.equal(latestDecisions([row], null, { limit: null }).length, 1, 'Activity retains the current failure.');
});

test('legacy empty reasons remain unavailable and saved review focus never comes from current settings', async () => {
  const { activityReason, reviewFocusPresentation, entryCardPresentation, matchesResultFilter } = await import('../public/desktop-ui.mjs');
  assert.equal(activityReason({ status: 'observed', reason: '  ' }), 'No reason was recorded for this result.');
  assert.notEqual(activityReason({ status: 'observed' }), 'Processing this entry.');
  assert.equal(activityReason({ status: 'observed', reason: ' Exact model words. ' }), ' Exact model words. ');
  assert.equal(reviewFocusPresentation(null).label, 'Review focus unavailable');
  assert.deepEqual(reviewFocusPresentation({ kind: 'custom', text: 'Original saved focus.' }), { label: 'Review focus: Custom', text: 'Original saved focus.' });
  assert.equal(reviewFocusPresentation({ kind: 'default', text: 'Saved default goal.' }, { prepared: true }).label, 'Prepared focus: Default research review');
  const entry = { version: 3, listener: { status: 'observed', decision: 'review', version: 2, reason: 'Prior accepted reason.' }, listenerCheck: { kind: 'research_check', status: 'waiting', reviewStatus: 'failed', version: 3 } };
  const card = entryCardPresentation(entry);
  assert.equal(card.outcome.label, 'Earlier response: review suggested · prior v2'); assert.equal(card.check.label, 'check failed');
  assert.equal(card.outcome.tone, '', 'The retained answer is secondary to the latest failed check.');
  assert.equal(matchesResultFilter(entry, 'decided'), true, 'The failed current check does not replace accepted review/filter truth.');
});

test('long entry result labels retain their full current/prior meaning and wrap only inside entry tags', async () => {
  const { entryCardPresentation } = await import('../public/desktop-ui.mjs');
  const card = entryCardPresentation({ version: 2147483647, listener: { version: 2147483646, status: 'observed', decision: 'review', reason: 'Saved response.' }, listenerCheck: { kind: 'research_check', status: 'waiting', reviewStatus: 'failed', version: 2147483647 } });
  assert.equal(card.check.label, 'check failed');
  assert.equal(card.outcome.label, 'Earlier response: review suggested · prior v2,147,483,646');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const entryRule = css.match(/\.entry-card \.tags \.pill\{([^}]+)\}/)?.[1];
  for (const declaration of ['max-width:100%', 'white-space:normal', 'overflow-wrap:anywhere', 'line-height:var(--lh-normal)']) assert.ok(entryRule.includes(declaration));
  assert.match(css.match(/\.pill\{[^}]+\}/)?.[0], /white-space:nowrap/, 'Pills outside entry cards preserve their existing behavior.');
});

test('inactive durable research progress says unfinished while the actual active review and ticket states retain their labels', async () => {
  const { activityStatus, listenerResult, modelOutputPresentation } = await import('../public/desktop-ui.mjs');
  const progress = { kind: 'research_check', status: 'processing' };
  assert.equal(activityStatus({ ...progress, activeReview: false }).label, 'check unfinished');
  assert.equal(activityStatus(progress).label, 'check unfinished');
  assert.equal(activityStatus({ status: 'processing' }).label, 'check unfinished', 'Legacy progress without live-check proof cannot claim an active model.');
  assert.equal(listenerResult({ ticket: null, listener: { status: 'processing' } }).label, 'check unfinished');
  assert.equal(activityStatus({ ...progress, activeReview: true }).label, 'reviewing');
  assert.equal(listenerResult({ ticket: null, listener: { ...progress, activeReview: false } }).label, 'check unfinished');
  assert.equal(listenerResult({ ticket: null, listener: { ...progress, activeReview: true } }).label, 'reviewing');
  assert.equal(activityStatus({ status: 'processing', decision: 'ticket' }).label, 'reviewing');
  assert.equal(activityStatus({ status: 'unknown', kind: 'orders' }).label, 'unconfirmed');
  assert.equal(activityStatus({ kind: 'research_check', status: 'waiting', reviewStatus: 'failed' }).label, 'check failed');
  assert.equal(activityStatus({ kind: 'research_check', status: 'waiting', reviewStatus: 'stopped' }).label, 'check unfinished');
  assert.deepEqual(activityStatus({ kind: 'research_check', status: 'waiting', reviewStatus: 'failed' }, { historical: true }), { label: 'earlier check failed', tone: '' });
  assert.equal(activityStatus({ kind: 'orders', decision: 'ticket', status: 'waiting' }, { historical: true }).label, 'waiting');
  assert.equal(activityStatus({ kind: 'orders', decision: 'ticket', status: 'waiting' }).label, 'waiting');
  assert.equal(modelOutputPresentation({ status: 'failed' }).label.toLowerCase(), 'check failed');
  assert.equal(modelOutputPresentation({ status: 'stopped' }).label.toLowerCase(), 'check unfinished');
});

test('Activity metadata identifies source revisions and uses only known completion clocks', async () => {
  const { activityMetadata } = await import('../public/desktop-ui.mjs');
  const row = { version: 1, status: 'observed', atUtc: '2026-10-23T12:00:00Z', completedAtUtc: '2026-10-23T12:01:00Z' };
  assert.deepEqual(activityMetadata(row, { version: 3 }), { revision: 'prior v1', clock: row.completedAtUtc, clockLabel: 'Completed', historical: true });
  assert.deepEqual(activityMetadata({ ...row, completedAtUtc: undefined }, { version: 1 }), { revision: 'v1', clock: row.atUtc, clockLabel: 'Recorded', historical: false });
  assert.deepEqual(activityMetadata({ ...row, status: 'waiting' }, { version: 3 }), { revision: 'prior v1', clock: row.atUtc, clockLabel: 'Recorded', historical: true });
  assert.equal(activityMetadata({ ...row, version: undefined }).revision, 'revision unknown');
  assert.equal(activityMetadata({ ...row, completedAtUtc: 'invalid' }).clockLabel, 'Recorded');
});

test('Latest decisions offers resume only for the current research revision while retaining historical rows and ticket hints', async () => {
  const { latestDecisions, completedModelPresentation, decisionShownInDesk, latestCheckPresentation, activityMetadata, activityStatus, activityReason } = await import('../public/desktop-ui.mjs');
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderDecisions()'), source.indexOf('/* -------------------------------------------------------------- settings */'));
  const row = { entryId: 'note', origin: 'local', kind: 'research_check', status: 'waiting', reason: 'An actual earlier model failure.', atUtc: '2026-10-23T12:00:00Z' };
  const activity = [{ ...row, id: 'prior', version: 2 }, { ...row, id: 'current', version: 3 }, { ...row, entryId: 'ticket', id: 'ticket-prior', version: 1, kind: undefined, decision: 'ticket' }];
  const node = (tag, textContent) => ({ tag, textContent, children: [], append(...children) { this.children.push(...children); } });
  const panel = { contains: () => false }, list = { closest: () => panel }, cards = []; let visibleIds = [];
  const context = { snapshot: { settings: { enabled: false }, listener: {}, activity, entries: [{ id: 'note', origin: 'local', version: 3 }, { id: 'ticket', origin: 'local', version: 3 }] },
    document: {}, $: () => list, latestDecisions, completedModelPresentation, decisionShownInDesk, latestCheckPresentation, activityMetadata, activityStatus, activityReason,
    decisionItems: (rows, details) => { visibleIds = rows.map(row => row.id); return rows.map(row => ({ value: { row, ...details(row) } })); }, changed: () => true,
    reconcileRows: (_list, items, draw) => { for (const item of items) cards.push(draw(item.value)); },
    element: node, pill: (_label, _tone) => node('span'), sourceButton: () => node('button'), when: value => value };
  runInNewContext(render, context); context.renderDecisions();
  const offersResume = card => card.children.some(child => child.textContent === 'Checks resume when you turn the Listener on.');
  assert.equal(cards.length, 3, 'All source history remains present.');
  assert.equal(offersResume(cards[0]), false); assert.equal(offersResume(cards[1]), true);
  assert.equal(offersResume(cards[2]), true, 'Ticket behavior remains unchanged.');
  context.snapshot.activity = activity.map(row => ({ ...row, checkId: row.id === 'current' ? 'retained-check' : 'other-check', reviewStatus: 'failed' }));
  context.snapshot.listener = { busy: false, modelOutput: null, lastError: null, modelReview: { id: 'retained-check', status: 'failed', restored: true, reason: row.reason, sources: [{ entryId: 'note', origin: 'local', version: 3 }] } };
  const retained = JSON.stringify(context.snapshot.activity); cards.length = 0; context.renderDecisions();
  assert.deepEqual(visibleIds, ['prior', 'ticket-prior'], 'Only the exact restored failed check already shown in the desk is redundant.');
  assert.equal(JSON.stringify(context.snapshot.activity), retained, 'Full Activity retains all original records.');
  context.snapshot.activity.push({ ...context.snapshot.activity[1], id: 'another-current', entryId: 'another-note' });
  context.snapshot.listener.modelReview.sources.push({ entryId: 'another-note', origin: 'local', version: 3 }); context.renderDecisions();
  assert.ok(visibleIds.includes('current') && visibleIds.includes('another-current'), 'Ambiguous same-check failures remain individually available.');
});

test('account identity comes only from a connected account profile', () => {
  assert.equal(accountPresentation({ connected: false, profile: { displayName: 'Old identity', email: 'old@example.test' } }).name, 'Local workspace');
  assert.deepEqual(accountPresentation({ connected: true, profile: { displayName: '  Sam  ', email: 'sam@example.test' } }), { name: 'Sam', detail: 'sam@example.test', initial: 'S', connected: true });
  assert.equal(accountPresentation({ connected: true }).name, 'Connected account');
  assert.equal(accountPresentation({ connected: true, profile: { displayName: 42 } }).name, 'Connected account');
});

test('update download and installation are separate explicit actions', () => {
  assert.equal(updatePresentation({ state: 'available', version: '0.2.0' }).action, 'downloadUpdate');
  assert.equal(updatePresentation({ state: 'downloaded' }).action, 'installUpdate');
  for (const state of ['idle', 'checking', 'downloading', 'current', 'unsupported', 'unrecognized']) assert.equal(updatePresentation({ state }).action, null);
  assert.equal(updatePresentation({ state: 'error' }).action, 'checkUpdates');
  assert.equal(updatePresentation({ state: 'unsupported' }).visible, false);
  assert.equal(updatePresentation({ state: 'current' }).visible, false);
});

test('progress is shown only when the native bridge reports a valid percentage', () => {
  for (const value of [undefined, null, '50', NaN, Infinity, -1, 101]) {
    assert.equal(updatePresentation({ state: 'downloading', percent: value }).percent, null);
    assert.equal(modelPresentation({ state: 'installing', percent: value }).percent, null);
  }
  for (const value of [0, 12.5, 100]) assert.equal(updatePresentation({ state: 'downloading', percent: value }).percent, value);
});

test('model setup is optional, reports native progress, and never claims unknown readiness', () => {
  assert.equal(modelPresentation({ state: 'missing' }).label, 'Set up local model');
  assert.equal(modelPresentation({ state: 'installing' }).busy, true);
  assert.equal(modelPresentation({ state: 'ready' }).visible, false);
  assert.equal(modelPresentation({ state: 'error' }).label, 'Retry local model');
  assert.equal(modelPresentation({ state: 'error', phase: 'runtime' }).title, 'Restart the local model');
  assert.equal(modelPresentation({ state: 'error', phase: 'setup' }).title, 'Set up the local model');
  assert.equal(modelPresentation({ state: 'error' }).title, 'Local model needs attention');
  assert.equal(modelPresentation({ state: 'error' }).state, 'error', 'The actual native state reaches the Retry control.');
  assert.equal(modelPresentation({ state: 'missing' }).title, 'Set up the local model');
  assert.equal(modelPresentation().visible, false);
  assert.equal(modelPresentation().busy, true);
});

test('appearance mirrors the website palettes and resolves System from the OS', async () => {
  const { THEME_OPTIONS, resolveTheme } = await import('../public/desktop-ui.mjs');
  const { THEMES } = await import('../src/schema.mjs');
  assert.deepEqual(THEME_OPTIONS.map(option => option.mode), THEMES);
  assert.equal(resolveTheme('system', true), 'classic-dark'); assert.equal(resolveTheme('system', false), 'classic');
  assert.equal(resolveTheme('atlantic', false), 'atlantic'); assert.equal(resolveTheme('unknown', true), 'classic-dark');
});

test('activity labels say what happened to a ticket in plain words', async () => {
  const { activityStatus, entryStatus } = await import('../public/desktop-ui.mjs');
  assert.deepEqual(activityStatus({ status: 'submitted' }), { label: 'submitted', tone: 'pos' });
  assert.deepEqual(activityStatus({ status: 'blocked' }), { label: 'refused', tone: 'neg' });
  assert.deepEqual(activityStatus({ status: 'observed', decision: 'candidate' }), { label: 'flagged', tone: 'info' });
  assert.equal(activityStatus({ status: 'answered' }).label, 'answered');
  assert.equal(entryStatus({ ticket: null }), null);
  assert.equal(entryStatus({ ticket: { error: 'Bad JSON' } }).tone, 'warn');
  assert.equal(entryStatus({ ticket: { kind: 'close' } }).label, 'close ticket');
});

test('Journal card reconciliation follows visible outcomes without replacing cards for new review clocks or reasons', async () => {
  const { entryCardPresentation } = await import('../public/desktop-ui.mjs');
  const entry = { id: 'note-a', origin: 'local', title: 'Research', body: 'Read the sources.', status: 'reviewed', version: 1, listener: { status: 'observed', decision: 'review', reason: 'First explanation.', atUtc: '2026-10-23T00:00:00Z' } };
  const options = { book: 'Research notebook', time: 'Oct 23, 12:00 AM', selected: true };
  const original = entryCardPresentation(entry, options);
  assert.deepEqual(entryCardPresentation({ ...entry, listener: { ...entry.listener, reason: 'A newer explanation.', atUtc: '2026-10-23T00:01:00Z' }, handoff: { reason: 'A changing source-owned status.' } }, options), original);
  assert.notDeepEqual(entryCardPresentation({ ...entry, listener: { ...entry.listener, decision: 'ignore' } }, options), original, 'A different visible decision updates its badge.');
  for (const change of [{ selected: false }, { book: 'Renamed notebook' }, { time: 'Oct 23, 12:01 AM' }]) assert.notDeepEqual(entryCardPresentation(entry, { ...options, ...change }), original);
  assert.notDeepEqual(entryCardPresentation({ ...entry, origin: 'cloud' }, options), original, 'Local and cloud entries with the same ID stay distinct.');
  const invalid = { ...entry, ticket: { error: 'Empty orders.' } };
  assert.deepEqual(entryCardPresentation({ ...invalid, ticket: { error: 'A corrected but still invalid draft.' } }, options), entryCardPresentation(invalid, options), 'The card shows the same error badge; the reader owns the exact current error.');
});

test('Journal reader core changes only with source content, not derived ticket or Listener annotations', async () => {
  const { entryReadingCore } = await import('../public/desktop-ui.mjs');
  const entry = { id: 'note-a', origin: 'local', title: 'Research', body: 'Keep this selected prose.', status: 'watching', version: 1, updatedAtUtc: '2026-10-23T00:00:00Z', signal: { quality: 'degraded', sourceOperationId: 'recorded-source' } };
  const original = entryReadingCore(entry, 'Research notebook');
  assert.deepEqual(entryReadingCore({ ...entry, ticket: { error: 'A derived ticket warning.' }, listener: { status: 'observed', reason: 'A fresh explanation.', atUtc: '2026-10-23T00:01:00Z' }, handoff: { reason: 'A fresh handoff.' } }, 'Research notebook'), original);
  for (const change of [{ id: 'note-b' }, { origin: 'cloud' }, { title: 'Renamed note' }, { body: 'New source prose.' }, { status: 'reviewed' }, { version: 2 }, { updatedAtUtc: '2026-10-23T00:02:00Z' }, { signal: { ...entry.signal, quality: 'fresh' } }]) assert.notDeepEqual(entryReadingCore({ ...entry, ...change }, 'Research notebook'), original);
  assert.notDeepEqual(entryReadingCore(entry, 'Renamed notebook'), original);
});

test('displayed submission and uncertain results never imply an order was filled', async () => {
  const { listenerResult, matchesResultFilter } = await import('../public/desktop-ui.mjs');
  for (const status of ['submitted', 'partial', 'pending', 'unknown']) {
    const entry = { ticket: { ticket: {} }, listener: { status } };
    assert.doesNotMatch(listenerResult(entry).label, /placed|filled|complete/);
    assert.equal(matchesResultFilter(entry, status === 'submitted' || status === 'partial' ? 'placed' : 'open'), true);
  }
  const note = { listener: { status: 'observed', decision: 'review' } };
  assert.equal(listenerResult(note).label, 'review suggested');
  assert.equal(matchesResultFilter(note, 'tickets'), false);
});

test('public process state keeps active work, errors, and unknown stages distinct', async () => {
  const { processingPresentation, processStage } = await import('../public/desktop-ui.mjs');
  assert.equal(processingPresentation({ busy: true, processing: { stage: 'model', message: 'Reviewing the note.' } }, true).message, 'Reviewing the note.');
  assert.equal(processingPresentation({ busy: true, processing: { stage: 'model' } }, true).label, 'Model review');
  assert.equal(processingPresentation({ busy: false, lastError: 'Account is unavailable.' }, true).tone, 'warn');
  assert.equal(processingPresentation({}, false).label, 'Listener off');
  assert.equal(processingPresentation({}, true).label, 'Ready');
  assert.equal(processStage('unrecognized'), 'Activity');
});

test('the Listener names one coarse state and keeps paused, ready, checked and error distinct', async () => {
  const { processingPresentation } = await import('../public/desktop-ui.mjs');
  assert.equal(processingPresentation({}, false).state, 'off');
  assert.equal(processingPresentation({}, true).state, 'ready');
  assert.equal(processingPresentation({ lastCheckedAtUtc: '2026-10-22T17:20:00Z' }, true).title, 'Checked');
  const paused = processingPresentation({ lastCheckedAtUtc: '2026-10-22T17:20:00Z', processing: { stage: 'paused', message: 'Check paused after a settings change or shutdown.' } }, true);
  assert.deepEqual([paused.state, paused.message], ['paused', 'Check paused after a settings change or shutdown.']);
  assert.equal(processingPresentation({ lastError: 'Model unavailable.', processing: { stage: 'paused' } }, true).state, 'error');
  const reviewing = processingPresentation({ busy: true, processing: { stage: 'model', index: 1, total: 2 } }, true);
  assert.deepEqual([reviewing.state, reviewing.title, reviewing.label, reviewing.position], ['reviewing', 'Reading', 'Model review', { index: 1, total: 2 }]);
  assert.equal(processingPresentation({ busy: true, processing: { stage: 'error' } }, true).state, 'error');
  for (const counts of [{}, { index: 0, total: 2 }, { index: 3, total: 2 }, { index: '1', total: 2 }, { index: 1.5, total: 2 }]) {
    assert.equal(processingPresentation({ busy: true, processing: { stage: 'read', ...counts } }, true).position, null);
  }
});

test('check intervals read in whole units without inventing a schedule', async () => {
  const { intervalLabel } = await import('../public/desktop-ui.mjs');
  assert.deepEqual([15, 60, 90, 120, 3600, 7200].map(intervalLabel), ['15 seconds', '1 minute', '90 seconds', '2 minutes', '1 hour', '2 hours']);
  for (const value of [0, -60, 1.5, null, '60']) assert.equal(intervalLabel(value), null);
});

test('partial or unmatched model output is never presented as an accepted decision', async () => {
  const { modelOutputPresentation } = await import('../public/desktop-ui.mjs');
  const output = { entryId: 'note-a', origin: 'local', title: 'Note', atUtc: '2026-10-22T17:20:00Z', text: '{"decision":"review","reason":"Needs a quantity."}' };
  const published = { entryId: 'note-a', origin: 'local', decision: 'review', reason: 'Needs a quantity.', atUtc: '2026-10-22T17:20:04Z' };
  for (const status of ['streaming', 'failed', 'stopped']) {
    const view = modelOutputPresentation({ ...output, status }, published);
    assert.equal(view.accepted, false); assert.equal(view.verdict, null); assert.match(view.note, /not accepted|Format check pending/);
  }
  const complete = modelOutputPresentation({ ...output, status: 'complete' }, published);
  assert.deepEqual([complete.accepted, complete.verdict], [true, { label: 'review suggested', tone: 'info', reason: 'Needs a quantity.' }]);
  for (const other of [null, { ...published, entryId: 'note-b' }, { ...published, origin: 'cloud' }, { ...published, atUtc: '2026-10-22T17:19:00Z' }, { ...published, atUtc: undefined }, { ...published, atUtc: 'invalid' }, { ...published, decision: 'submit' }]) {
    const view = modelOutputPresentation({ ...output, status: 'complete' }, other);
    assert.equal(view.accepted, false); assert.equal(view.verdict, null);
  }
  for (const atUtc of [undefined, null, 'invalid']) assert.equal(modelOutputPresentation({ ...output, atUtc, status: 'complete' }, published).accepted, false);
  const reconnecting = modelOutputPresentation({ ...output, status: 'streaming' }, null, { disconnected: true });
  assert.deepEqual([reconnecting.label, reconnecting.live], ['Reconnecting', false]);
  assert.equal(modelOutputPresentation({ ...output, status: 'streaming' }).live, true);
  assert.equal(modelOutputPresentation({ ...output, text: '', status: 'streaming' }).empty, 'Waiting for the model’s first response token.');
  assert.equal(modelOutputPresentation({ ...output, status: 'unexpected' }).label, 'Unavailable');
});

test('the streamed reason is decoded only from complete JSON text and never runs ahead of the final answer', async () => {
  const { streamedReason } = await import('../public/desktop-ui.mjs');
  const full = '{\n  "decision": "review",\n  "reason": "Say \\"hold\\" \\\\ wait\\nthen caf\\u00e9 \\ud83d\\ude00 \\/ done."\n}';
  const final = JSON.parse(full).reason;
  let previous = '';
  for (let end = 0; end <= full.length; end += 1) {
    const read = streamedReason(full.slice(0, end));
    assert.notEqual(read, null, `prefix ${end} should stay readable`);
    if (read.reason === null) continue;
    assert.ok(final.startsWith(read.reason), `prefix ${end} decoded past the final answer`);
    assert.doesNotMatch(read.reason, /[\uD800-\uDBFF]$/);
    assert.ok(read.reason.length >= previous.length); previous = read.reason;
  }
  assert.equal(streamedReason(full).reason, final);
  assert.deepEqual(streamedReason('{"decision": "rev'), { reason: null });
  assert.deepEqual(streamedReason('{"decision":"review","reason":'), { reason: null });
  assert.equal(streamedReason('{"decision":"review","reason":"a\\').reason, 'a');
  assert.equal(streamedReason('{"decision":"review","reason":"a\\u00').reason, 'a');
  assert.equal(streamedReason('{"reason":"first","reason":"second"}').reason, JSON.parse('{"reason":"first","reason":"second"}').reason);
  for (const unreadable of ['Sure! {"reason":"x"}', '[{"reason":"x"}]', '{"decision":1,"reason":"x"}', '{"reason":"x\\q"}', '{"reason":"x\\u00zz"}', '{"reason":"line\nbreak"}', '{"reason":"x"} trailing', '{"reason":"x",}', '{"a":"b" "reason":"x"}', null]) {
    assert.equal(streamedReason(unreadable), null, String(unreadable));
  }
});

test('a streamed reason is a labelled draft until the same run is published', async () => {
  const { modelOutputPresentation } = await import('../public/desktop-ui.mjs');
  const base = { entryId: 'note-a', origin: 'local', title: 'Note', atUtc: '2026-10-22T17:20:00Z' };
  const published = { entryId: 'note-a', origin: 'local', decision: 'review', reason: 'Needs a quantity.', atUtc: '2026-10-22T17:20:04Z' };
  const streaming = modelOutputPresentation({ ...base, status: 'streaming', text: '{"decision":"review","reason":"Needs a qua' }, published);
  assert.deepEqual([streaming.draft, streaming.draftLabel, streaming.verdict, streaming.accepted], ['Needs a qua', 'Reason so far', null, false]);
  assert.match(streaming.note, /Format check pending/);
  assert.equal(modelOutputPresentation({ ...base, status: 'streaming', text: '{"decision":"rev' }).draft, '');
  assert.equal(modelOutputPresentation({ ...base, status: 'streaming', text: 'Not JSON at all' }).draft, null);
  const stopped = modelOutputPresentation({ ...base, status: 'stopped', text: '{"decision":"review","reason":"Needs' });
  assert.deepEqual([stopped.draft, stopped.draftLabel, stopped.verdict], ['Needs', 'Partial reason', null]);
  assert.match(stopped.note, /not accepted/);
  for (const text of ['{"decision":"review","reason":', '{"decision":"review","reason":"']) {
    assert.equal(modelOutputPresentation({ ...base, status: 'stopped', text }).draft, null);
  }
  const text = '{"decision":"review","reason":"Needs a quantity."}';
  const unmatched = modelOutputPresentation({ ...base, status: 'complete', text }, { ...published, entryId: 'note-b' });
  assert.deepEqual([unmatched.draft, unmatched.draftLabel, unmatched.verdict], ['Needs a quantity.', 'Model reason', null]);
  const accepted = modelOutputPresentation({ ...base, status: 'complete', text }, published);
  assert.deepEqual([accepted.draft, accepted.verdict.reason], [null, 'Needs a quantity.']);
  assert.deepEqual([modelOutputPresentation(null).draft, modelOutputPresentation({ ...base, status: 'streaming', text: '' }).draft], [null, null]);
});

test('an empty model output names the next action for the current Listener state', async () => {
  const { modelOutputPresentation } = await import('../public/desktop-ui.mjs');
  assert.match(modelOutputPresentation(null, null, { enabled: false }).empty, /^Turn the Listener on/);
  assert.match(modelOutputPresentation(null, null, { enabled: true }).empty, /Choose Check now/);
  assert.match(modelOutputPresentation(null, null, { enabled: true, busy: true }).empty, /^Reading the Journal/);
  assert.equal(modelOutputPresentation(null).label, 'Not run');
});

test('completion announcements survive streaming without repeating an unchanged scheduled outcome', async () => {
  const { modelOutputPresentation, completionAnnouncement } = await import('../public/desktop-ui.mjs');
  const output = { entryId: 'note-a', origin: 'local', version: 1, status: 'complete', atUtc: '2026-10-23T10:00:00Z' };
  const published = { ...output, decision: 'review', reason: 'An exact quantity is still needed.' };
  const first = completionAnnouncement(modelOutputPresentation(output, published), output);
  assert.equal(first.message, 'Review complete: review suggested.');
  assert.doesNotMatch(first.message, /exact quantity/);
  const streaming = { ...output, status: 'streaming', atUtc: '2026-10-23T10:01:00Z' };
  assert.equal(completionAnnouncement(modelOutputPresentation(streaming, published), streaming, first.key), null);
  const next = { ...streaming, status: 'complete' }, repeated = { ...published, atUtc: next.atUtc };
  assert.equal(completionAnnouncement(modelOutputPresentation(next, repeated), next, first.key), null);
  for (const change of [{ reason: 'The risk limit changed.' }, { decision: 'ignore' }, { entryId: 'note-b' }, { origin: 'cloud' }, { version: 2 }]) {
    const source = { ...next, ...change }, result = { ...repeated, ...change };
    assert.ok(completionAnnouncement(modelOutputPresentation(source, result), source, first.key));
  }
  const error = completionAnnouncement(modelOutputPresentation(next, repeated), next, first.key, 'The model is unavailable.');
  assert.match(error.message, /needs attention.*model is unavailable/);
  assert.equal(completionAnnouncement(modelOutputPresentation(next, repeated), next, error.key, 'The model is unavailable.'), null);
  assert.ok(completionAnnouncement(modelOutputPresentation(next, repeated), next, error.key, 'The response was invalid.'));
  assert.ok(completionAnnouncement(modelOutputPresentation(next, repeated), next, error.key), 'Recovery is a real changed outcome.');
  for (const status of ['failed', 'stopped']) {
    const failed = { ...next, status }, view = modelOutputPresentation(failed, repeated);
    const announcement = completionAnnouncement(view, failed, first.key);
    assert.match(announcement.message, /No decision was accepted/);
    assert.equal(completionAnnouncement(view, { ...failed, atUtc: '2026-10-23T10:02:00Z' }, announcement.key), null);
    assert.ok(completionAnnouncement(modelOutputPresentation(next, repeated), next, announcement.key));
  }
  assert.equal(completionAnnouncement(modelOutputPresentation(next, null), next), null, 'An unmatched response is never announced as accepted.');
});

test('local draft protection compares every actual field and clears on an exact revert', async () => {
  const { localDraftDirty } = await import('../public/desktop-ui.mjs');
  const base = { notebookId: 'book-a', title: 'Research', body: 'Original writing.\n', status: 'watching', signal: '' };
  assert.equal(localDraftDirty(null, base), false);
  assert.equal(localDraftDirty(base, { ...base }), false);
  for (const field of Object.keys(base)) {
    const edited = { ...base, [field]: base[field] + ' changed' };
    assert.equal(localDraftDirty(base, edited), true, field);
    assert.equal(localDraftDirty(base, { ...edited, [field]: base[field] }), false, `${field} reverted`);
  }
  assert.equal(localDraftDirty(base, { ...base, body: base.body.trimEnd() }), true, 'Whitespace is part of the draft.');
  assert.equal(localDraftDirty({ ...base, body: '' }, { ...base, body: '' }), false, 'Empty new-entry fields start clean.');
});

test('a published decision appears once when model start and completion timestamps differ', async () => {
  const { latestDecisions } = await import('../public/desktop-ui.mjs');
  const row = { entryId: 'note-a', origin: 'local', version: 1, decision: 'review', reason: 'An exact quantity is needed.', status: 'observed', atUtc: '2026-10-22T17:20:00Z' };
  const output = { entryId: row.entryId, origin: row.origin, decision: row.decision, reason: row.reason, atUtc: '2026-10-22T17:21:00Z' };
  assert.deepEqual(latestDecisions([row], output), [row]);
  const otherEntry = { ...row, entryId: 'note-b' }, otherOrigin = { ...row, origin: 'cloud' }, otherRevision = { ...row, version: 2 };
  assert.deepEqual(latestDecisions([otherRevision, otherEntry, otherOrigin, row], { ...output, version: 2 }), [otherRevision, otherEntry, otherOrigin, row]);
  const newRevisionOutput = { ...output, version: 3 };
  assert.deepEqual(latestDecisions([otherRevision, row], newRevisionOutput), [{ ...newRevisionOutput, status: 'observed' }, otherRevision, row]);
  assert.equal(latestDecisions([otherEntry, otherOrigin], output).length, 3);
});


test('recent decisions keep a newer paused check above an older published response', async () => {
  const { latestDecisions } = await import('../public/desktop-ui.mjs');
  const published = { entryId: 'note-a', origin: 'local', decision: 'review', reason: 'Needs context.', atUtc: '2026-10-22T17:20:10Z' };
  const paused = { entryId: 'note-a', origin: 'local', status: 'waiting', reason: 'Paused before a decision.', atUtc: '2026-10-22T17:20:45Z' };
  const unknownClock = { entryId: 'note-b', status: 'waiting', atUtc: null };
  assert.deepEqual(latestDecisions([unknownClock, paused], published), [paused, { ...published, status: 'observed' }, unknownClock]);
});

test('decision row identities survive insertion and updates without conflating retained checks', async () => {
  const { latestDecisions, decisionRowKeys } = await import('../public/desktop-ui.mjs');
  const prior = { id: 'check-a', entryId: 'note-a', origin: 'local', version: 1, status: 'unknown', atUtc: '2026-10-22T17:20:00Z' };
  const newer = { ...prior, id: 'check-b', version: 2, atUtc: '2026-10-22T17:21:00Z' };
  const key = decisionRowKeys([prior])[0];
  assert.equal(decisionRowKeys([newer, prior])[1], key);
  assert.equal(decisionRowKeys([{ ...prior, status: 'resolved', reason: 'Owner checked.', attemptId: 'attempt-a' }])[0], key);
  assert.notEqual(decisionRowKeys([newer])[0], key);
  const published = { entryId: prior.entryId, origin: prior.origin, version: 1, decision: 'review', reason: 'Needs context.', atUtc: prior.atUtc };
  const waiting = { ...published, status: 'waiting' };
  const rows = latestDecisions([waiting], published, { limit: null });
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(decisionRowKeys(rows)).size, 2);
  const summaryKey = decisionRowKeys(rows)[1];
  assert.equal(decisionRowKeys([newer, ...rows])[2], summaryKey);
  // Identical retained rows are still distinct nodes; identity assignment never drops history.
  assert.equal(new Set(decisionRowKeys([waiting, waiting])).size, 2);
});

test('receipt details preserve explicit order and close refusal codes without inventing an explanation', async () => {
  const { receiptDetails } = await import('../public/desktop-ui.mjs');
  for (const identity of [{ instrumentId: 'kraken:BTCUSD' }, { positionId: 'owned-position' }]) {
    assert.deepEqual(receiptDetails({ ...identity, message: 'Order was not submitted.', riskCode: ' RISK_TRADING_HALTED ' }), { message: 'Order was not submitted.', riskCode: 'RISK_TRADING_HALTED' });
  }
  assert.deepEqual(receiptDetails({ riskCode: 'RISK_TRADING_HALTED' }), { message: '', riskCode: 'RISK_TRADING_HALTED' });
  for (const riskCode of [null, { secret: 'not a code' }, '<script>run()</script>', 'RISK\nHALTED', 'A'.repeat(81)]) {
    assert.deepEqual(receiptDetails({ message: 'Original message.', riskCode }), { message: 'Original message.', riskCode: null });
  }
  assert.equal(receiptDetails({ riskCode: 'A'.repeat(80) }).riskCode.length, 80);
  assert.deepEqual(receiptDetails({ message: { secret: 'not a message' }, detail: 'unknown data' }), { message: '', riskCode: null });
});

test('Operations event keys survive appended updates and retain the exact newest thirty source events', async () => {
  const { decisionRowKeys } = await import('../public/desktop-ui.mjs');
  const events = Array.from({ length: 31 }, (_, index) => ({ id: `source-event-${index}`, entryId: 'research', origin: 'local', stage: 'model', message: `Actual event ${index}.`, atUtc: `2026-10-23T00:00:${String(index).padStart(2, '0')}Z` }));
  const earlier = events.slice(0, 30), current = events.slice(-30);
  const before = decisionRowKeys(earlier), after = decisionRowKeys(current);
  assert.equal(current.length, 30); assert.equal(current[0], events[1]); assert.equal(current.at(-1), events.at(-1));
  assert.deepEqual(after.slice(0, -1), before.slice(1), 'Surviving rows keep their source keys and therefore their focused controls.');
  assert.equal(decisionRowKeys([{ ...events[1], message: 'Updated source explanation.' }])[0], before[1], 'A revised event uses the same focus-restoration identity.');
});

test('immediate switches keep saved risk values and reject unrelated fields', async () => {
  const { settingsSwitchBody } = await import('../public/desktop-ui.mjs');
  const { DEFAULT_SETTINGS, settingsInput } = await import('../src/schema.mjs');
  const saved = { ...DEFAULT_SETTINGS, version: 7, listenerId: 'private-local-id', risk: { ...DEFAULT_SETTINGS.risk, maxOrderUsd: 25 } };
  const off = settingsSwitchBody({ ...saved, enabled: true }, 'enabled', false);
  assert.equal(off.enabled, false); assert.equal(off.risk.maxOrderUsd, 25);
  assert.equal(off.version, 7); assert.equal('listenerId' in off, false);
  assert.equal(settingsInput(off).enabled, false);
  assert.equal(saved.enabled, false); assert.equal(saved.risk.maxOrderUsd, 25);
  assert.throws(() => settingsSwitchBody(saved, 'risk', {}), /Invalid/);
  assert.throws(() => settingsSwitchBody(saved, 'enabled', 'false'), /Invalid/);
});

test('unconfirmed order results remain visible above five newer research decisions', async () => {
  const { latestDecisions } = await import('../public/desktop-ui.mjs');
  const old = { entryId: 'old-ticket', status: 'unknown', atUtc: '2026-10-22T15:00:00Z' };
  const pending = { entryId: 'pending-ticket', status: 'pending', atUtc: '2026-10-22T15:01:00Z' };
  const research = Array.from({ length: 7 }, (_, i) => ({ entryId: `note-${i}`, status: 'observed', atUtc: `2026-10-22T16:0${i}:00Z` }));
  const result = latestDecisions([...research, old, pending]);
  assert.equal(result.length, 5); assert.deepEqual(result.slice(0, 2), [pending, old]);
  assert.deepEqual(result.slice(2).map(row => row.entryId), ['note-6', 'note-5', 'note-4']);
});

test('full Activity includes the preview without truncating retained history or hiding unconfirmed results', async () => {
  const { latestDecisions } = await import('../public/desktop-ui.mjs');
  const unknown = { entryId: 'old-ticket', status: 'unknown', atUtc: '2026-10-22T15:00:00Z' };
  const history = Array.from({ length: 8 }, (_, index) => ({ entryId: `note-${index}`, origin: 'local', status: 'observed', decision: 'review', reason: `Reason ${index}.`, atUtc: `2026-10-22T16:0${index}:00Z` }));
  const output = { entryId: 'latest-note', origin: 'local', decision: 'review', reason: 'Newest published reason.', atUtc: '2026-10-22T17:00:00Z' };
  const original = [unknown, ...history], before = structuredClone(original);
  const full = latestDecisions(original, output, { limit: null });
  assert.equal(full.length, 10);
  assert.equal(full[0], unknown);
  assert.deepEqual(full[1], { ...output, status: 'observed' });
  assert.deepEqual(latestDecisions(original, output), full.slice(0, 5));
  assert.deepEqual(original, before);
  assert.equal(latestDecisions([...original, { ...output, status: 'observed' }], output, { limit: null }).length, 10);
  assert.deepEqual(latestDecisions([], output, { limit: null }), [{ ...output, status: 'observed' }]);
});


test('completed model reviews and owner-resolved uncertainty are not unsubmitted or pending tickets', async () => {
  const { matchesResultFilter } = await import('../public/desktop-ui.mjs');
  const review = { listener: { status: 'observed', decision: 'review' } };
  assert.equal(matchesResultFilter(review, 'decided'), true);
  assert.equal(matchesResultFilter(review, 'open'), false);
  const resolved = { ticket: { ticket: {} }, listener: { status: 'resolved' } };
  assert.equal(matchesResultFilter(resolved, 'resolved'), true);
  assert.equal(matchesResultFilter(resolved, 'refused'), false);
});


test('new local notebooks become selectable in an open editor without replacing its option, draft or caret', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('function refreshEntryNotebooks('), source.indexOf('function showEditor('));
  const first = { value: 'original', textContent: 'Original notebook' }, select = { value: 'original', options: [first],
    insertBefore(node, before) { const old = this.options.indexOf(node); if (old >= 0) this.options.splice(old, 1); const index = this.options.indexOf(before); this.options.splice(index < 0 ? this.options.length : index, 0, node); },
    removeChild(node) { this.options.splice(this.options.indexOf(node), 1); } };
  const body = { value: 'Unsaved exact text', selectionStart: 8, selectionEnd: 13 }, base = { body: 'Saved text' };
  const context = { $: id => id === 'entry-notebook' ? select : body, snapshot: { notebooks: [{ id: 'original', origin: 'local', name: 'Renamed notebook' }, { id: 'new', origin: 'local', name: 'Newly created' }, { id: 'cloud', origin: 'cloud', name: 'Cloud' }] },
    Option: function(textContent, value) { Object.assign(this, { textContent, value }); }, editorBase: base, entryRetryKey: 'stable-retry', document: { activeElement: body } };
  runInNewContext(helper, context); assert.equal(typeof context.refreshEntryNotebooks, 'function'); context.refreshEntryNotebooks();
  assert.equal(select.options[0], first); assert.equal(first.textContent, 'Renamed notebook'); assert.equal(select.value, 'original');
  assert.deepEqual(select.options.map(row => row.value), ['original', 'new']);
  assert.equal(context.editorBase, base); assert.equal(context.entryRetryKey, 'stable-retry'); assert.equal(context.document.activeElement, body);
  assert.deepEqual(body, { value: 'Unsaved exact text', selectionStart: 8, selectionEnd: 13 });
  const options = [...select.options]; context.refreshEntryNotebooks(); assert.deepEqual(select.options, options);
  select.value = 'new'; context.refreshEntryNotebooks(); assert.equal(select.value, 'new');
  const load = source.slice(source.indexOf('async function load('), source.indexOf('function renderStatus('));
  assert.match(load, /if \(!\$\('editor'\)\.hidden\) refreshEntryNotebooks\(\)/);
});

test('workspace disclosure follows its trigger in keyboard order and keyboard opening focuses its first usable control', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="account-toggle"') < html.indexOf('id="account-menu"'));
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const handlers = source.slice(source.indexOf("$('account-toggle').addEventListener('click'"), source.indexOf("$('account-settings').addEventListener"));
  const callbacks = new Map(); let focused = 'toggle'; const hidden = { disabled: false, closest: () => true, focus() { focused = 'hidden'; } }, disabled = { disabled: true, closest: () => null, focus() { focused = 'disabled'; } }, control = { disabled: false, closest: () => null, focus() { focused = 'first'; } };
  const toggle = { addEventListener: (event, callback) => callbacks.set(`toggle:${event}`, callback), setAttribute(name, value) { this[name] = value; } }, menu = { hidden: true, querySelectorAll: () => [hidden, disabled, control] }, area = { contains: target => target === toggle || target === control, addEventListener: (event, callback) => callbacks.set(`area:${event}`, callback) };
  const context = { $: id => ({ 'account-toggle': toggle, 'account-menu': menu, 'account-area': area })[id], document: { addEventListener: (event, callback) => callbacks.set(`document:${event}`, callback) }, closeAccountMenu({ focus = false } = {}) { menu.hidden = true; toggle['aria-expanded'] = 'false'; if (focus) focused = 'toggle'; } };
  runInNewContext(handlers, context); callbacks.get('toggle:click')({ detail: 1 }); assert.equal(menu.hidden, false); assert.equal(focused, 'toggle', 'Pointer opening retains pointer focus.');
  callbacks.get('toggle:click')({ detail: 1 }); callbacks.get('toggle:click')({ detail: 0 }); assert.equal(focused, 'first'); assert.equal(toggle['aria-expanded'], 'true');
  callbacks.get('document:keydown')({ key: 'Escape' }); assert.equal(menu.hidden, true); assert.equal(focused, 'toggle');
  callbacks.get('toggle:click')({ detail: 0 }); callbacks.get('document:click')({ target: {} }); assert.equal(menu.hidden, true);
  callbacks.get('toggle:click')({ detail: 0 }); callbacks.get('area:focusout')({ relatedTarget: control }); assert.equal(menu.hidden, false);
  const next = {}; focused = next; callbacks.get('area:focusout')({ relatedTarget: next }); assert.equal(menu.hidden, true); assert.equal(focused, next, 'Tabbing out closes the panel without returning focus to its trigger.');
});

test('notices have one exposed message source and settings subsection headings nest below their title', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<span id="notice-text" aria-hidden="true"><\/span>/);
  assert.match(html, /id="notice-status"[^>]*role="status"/); assert.match(html, /id="notice-alert"[^>]*role="alert"/);
  assert.match(html, /<button id="dismiss-notice"[^>]*aria-label="Dismiss message"/);
  const settings = html.slice(html.indexOf('id="listener-configuration"'), html.indexOf('</form>', html.indexOf('id="listener-configuration"')));
  assert.equal((settings.match(/<h2/g) ?? []).length, 1);
  for (const title of ['Watch', 'Auto-trade', 'Local model']) assert.ok(settings.includes(`<h3>${title}</h3>`));
});

test('Activity timestamps use a single data text node with the actual clock label and seconds', async () => {
  const ui = await import('../public/desktop-ui.mjs'), source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function renderActivity('), source.indexOf('// EventSource reconnects', source.indexOf('function renderActivity(')));
  const make = (tag, content, className) => ({ tag, textContent: content ?? '', className, children: [], dataset: {}, append(...children) { this.children.push(...children); } });
  const row = { id: 'result', origin: 'local', entryId: 'note', status: 'observed', decision: 'review', version: 2, reason: 'Real result', atUtc: '2026-10-23T10:00:00Z', completedAtUtc: '2026-10-23T10:00:04Z' };
  let card;
  const context = { ...ui, snapshot: { activity: [row], listener: {}, attempts: [], entries: [{ id: 'note', origin: 'local', version: 2 }], settings: {} }, $: () => ({}),
    decisionItems: rows => rows.map(row => ({ value: { row, ...ui.activityMetadata(row, { version: 2 }) } })), changed: () => true, reconcileRows: (_list, items, render) => { card = render(items[0].value); },
    element: make, pill: (text, tone) => make('span', text, tone), sourceButton: () => make('button', 'Source note'), when: (clock, seconds) => `${clock}/${seconds ? 'seconds' : 'minutes'}` };
  runInNewContext(fn, context); context.renderActivity(); const time = card.children[0].children.find(node => node.tag === 'time');
  assert.equal(time.textContent, 'Completed 2026-10-23T10:00:04Z/seconds'); assert.equal(time.className, 'mono'); assert.equal(time.children.length, 0); assert.equal(time.dateTime, row.completedAtUtc);
});


test('dismissed pending notebook creation cannot submit twice and its later refusal remains visible', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const handlers = source.slice(source.indexOf('let notebookSaving'), source.indexOf("$('sync').addEventListener"));
  for (const dismiss of ['cancel', 'escape']) {
    const callbacks = new Map(), nodes = new Map(), jobs = [], notices = []; let requests = 0, reject;
    const pending = new Promise((_resolve, refuse) => { reject = refuse; });
    const get = id => { if (!nodes.has(id)) nodes.set(id, { value: id === 'notebook-name' ? 'Retained name' : '', hidden: true, disabled: false,
      addEventListener: (event, callback) => callbacks.set(`${id}:${event}`, callback), setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      showModal() { this.open = true; }, close() { this.open = false; } }); return nodes.get(id); };
    const context = { updateDraftProtection() {}, $: get, document: { activeElement: {}, body: {} }, crypto: { randomUUID: () => 'stable-notebook-key' }, formDirty: false, api: async () => { requests++; await pending; }, load: async () => assert.fail('A refused create must not refresh or report success.'),
      action: (_button, work) => jobs.push(work()), notify: (message, success, error) => notices.push({ message, success, error }) };
    runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
    runInNewContext(handlers, context); callbacks.get('new-notebook:click')(); const submit = () => callbacks.get('notebook-form:submit')({ preventDefault() {}, submitter: get('create-notebook') });
    submit(); assert.equal(get('notebook-save-state').hidden, true, 'The modal owns the active save message.'); assert.match(get('notebook-save-message').textContent, /does not cancel/); assert.equal(get('cancel-notebook').textContent, 'Close while saving'); if (dismiss === 'cancel') callbacks.get('cancel-notebook:click')(); else get('notebook-dialog').close();
    callbacks.get('new-notebook:click')(); submit(); assert.equal(requests, 1); assert.equal(get('notebook-name').disabled, true);
    get('notebook-dialog').close(); reject(Object.assign(new Error('The actual create request was refused.'), { status: 400 })); await jobs[0];
    assert.equal(get('notebook-save-state').hidden, true); assert.equal(get('cancel-notebook').textContent, 'Cancel'); assert.equal(get('notebook-dialog').open, false); assert.equal(get('notebook-name').value, 'Retained name'); assert.equal(get('notebook-name').disabled, false); assert.equal(get('create-notebook').disabled, false);
    assert.deepEqual(notices, [{ message: 'The actual create request was refused.', success: false, error: true }]);
    assert.equal(requests, 1); assert.equal(get('notebook-name').readOnly, false, 'A definitive refusal releases the request for correction.'); callbacks.get('new-notebook:click')(); assert.equal(get('notebook-name').value, 'Retained name');
  }
});


test('an uncertain notebook create retains its original request through dismissal and exact retry; a confirmed save releases it', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const handlers = source.slice(source.indexOf('let notebookSaving'), source.indexOf("$('sync').addEventListener"));
  for (const failure of [new TypeError('Network reply lost.'), new SyntaxError('Reply could not be parsed.'), Object.assign(new Error('Server result unavailable.'), { status: 500 })]) {
    const callbacks = new Map(), nodes = new Map(), jobs = [], notices = [], requests = []; let key = 0, reject;
    const pending = new Promise((_resolve, refuse) => { reject = refuse; });
    const get = id => { if (!nodes.has(id)) nodes.set(id, { value: id === 'notebook-name' ? 'Original requested name' : '', hidden: true, disabled: false,
      addEventListener: (event, callback) => callbacks.set(`${id}:${event}`, callback), setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; }, showModal() { this.open = true; }, close() { this.open = false; } }); return nodes.get(id); };
    const context = { updateDraftProtection() {}, $: get, document: { activeElement: {}, body: {} }, crypto: { randomUUID: () => `intent-${++key}` }, formDirty: false,
      api: async (path, body, headers) => { requests.push({ path, body: { ...body }, headers: { ...headers } }); if (requests.length === 1) await pending; return { id: 'committed-notebook' }; },
      load: async () => { throw new Error('Readback unavailable after confirmed save.'); }, action: (_button, work) => jobs.push(work()), notify: (message, success, error) => notices.push({ message, success, error }) };
    runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
    runInNewContext(handlers, context); const submit = () => callbacks.get('notebook-form:submit')({ preventDefault() {}, submitter: get('create-notebook') });
    callbacks.get('new-notebook:click')(); submit(); callbacks.get('cancel-notebook:click')(); reject(failure); await jobs[0];
    assert.equal(get('notebook-name').readOnly, true); assert.equal(get('notebook-name').value, 'Original requested name'); assert.equal(notices.length, 0, 'The persistent reminder replaces the duplicate toast.'); assert.equal(get('notebook-dialog-title').textContent, 'Notebook save unconfirmed'); assert.equal(get('notebook-save-state').hidden, false); assert.match(get('notebook-save-message').textContent, /unconfirmed/); assert.equal(get('cancel-notebook').textContent, 'Close with save unconfirmed'); callbacks.get('resume-notebook-save:click')(); assert.equal(get('notebook-dialog').open, true); assert.equal(get('notebook-save-state').hidden, true, 'The resumed modal has one error presentation.');
    callbacks.get('new-notebook:click')(); get('notebook-name').value = 'Changed DOM must not change retry'; submit(); await jobs[1];
    assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]); assert.equal(requests[0].headers['Idempotency-Key'], 'intent-1');
    assert.equal(get('notebook-save-state').hidden, true); assert.equal(get('notebook-save-message').textContent, ''); assert.equal(get('notebook-name').readOnly, false); assert.equal(get('notebook-name').value, ''); assert.match(notices.at(-1).message, /Notebook added, but the list could not refresh/);
    callbacks.get('new-notebook:click')(); get('notebook-name').value = 'Original requested name'; submit(); await jobs[2];
    assert.equal(requests[2].headers['Idempotency-Key'], 'intent-2', 'An intentional same-named notebook is a new operation after confirmed success.');
  }
});


test('dismissing or auto-hiding a notice clears its live text and cancels a pending announcement', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function notify('), source.indexOf('async function api('));
  const nodes = new Map(), frames = new Map(); let next = 0, timer;
  const get = id => { if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', className: '' }); return nodes.get(id); };
  const context = { $: get, requestAnimationFrame: callback => { frames.set(++next, callback); return next; }, cancelAnimationFrame: id => frames.delete(id), clearTimeout() {}, setTimeout: callback => { timer = callback; return 1; } };
  runInNewContext(functions, context); const flush = () => { for (const [id, callback] of frames) { frames.delete(id); callback(); } };
  context.notify('Notebook added.', true); flush(); assert.equal(get('notice-status').textContent, 'Notebook added.');
  assert.equal(typeof context.dismissNotice, 'function'); context.dismissNotice(); assert.equal(get('notice').hidden, true); assert.equal(get('notice-status').textContent, ''); assert.equal(get('notice-alert').textContent, '');
  context.notify('Saved.', true); context.dismissNotice(); flush(); assert.equal(get('notice-status').textContent, '', 'Dismiss cancels an announcement that has not yet run.');
  context.notify('Saved again.', true); flush(); timer(); assert.equal(get('notice').hidden, true); assert.equal(get('notice-status').textContent, '');
  assert.match(source, /\$\('dismiss-notice'\)\.addEventListener\('click', dismissNotice\)/);
});

test('narrow editor creation stays reachable, notebook controls have distinct names and risk help is outside labels', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /<label>Filter by notebook<select id="journal-filter"/); assert.match(html, /<label>Save in notebook<select id="entry-notebook"/);
  assert.match(css, /#view-journal:has\(#editor:not\(\[hidden\]\)\) \.head-actions>\*:not\(#new-notebook\)\{display:none\}/);
  assert.doesNotMatch(css, /#view-journal:has\(#editor:not\(\[hidden\]\)\) \.head-actions\{display:none\}/);
  for (const [id, name] of [['max-order', 'Max per order'], ['max-ticket', 'Max per ticket'], ['max-leverage', 'Max leverage']]) {
    assert.match(html, new RegExp(`<label for="${id}">${name}${id === 'max-leverage' ? '' : '<span class="sr-only"> in USD</span>'}</label>`));
    assert.ok([...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].every(([label]) => !label.includes(`id="${id}-error"`)));
  }
  const forced = css.slice(css.indexOf('@media(forced-colors:active)'), css.indexOf('\n}', css.indexOf('@media(forced-colors:active)')));
  assert.match(forced, /input:focus,select:focus,textarea:focus\{outline:2px solid Highlight/);
  assert.match(forced, /\.affix:focus-within\{outline:2px solid Highlight/);
});

test('failed local entry save restores a disabled focused control only when focus fell to body', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("$('entry-form').addEventListener('submit'"), source.indexOf('let notebookSaving'));
  for (const deliberate of [false, true]) {
    let submit, reject, job, restores = 0; const body = {}, other = {}, doc = { body }, nodes = {};
    const button = { isConnected: true, focus() { doc.activeElement = this; restores++; }, get disabled() { return this.off; }, set disabled(value) { this.off = value; if (value && doc.activeElement === this) doc.activeElement = body; } };
    doc.activeElement = button;
    for (const [id, value] of Object.entries({ 'entry-notebook': 'book', 'entry-title': 'Unsaved title', 'entry-body': 'Exact notes', 'entry-status': 'watching', 'entry-signal': '' })) nodes[id] = { value, disabled: false };
    nodes['entry-form'] = { elements: [...Object.values(nodes), button], setAttribute() {}, removeAttribute() {}, addEventListener(_event, callback) { submit = callback; } };
    const context = { $: id => nodes[id], document: doc, entrySaving: false, entryIntent: null, entrySavePendingMessage: 'The original save is unconfirmed.', renderEntrySaveState() {}, crypto: { randomUUID: () => 'new-entry-key' }, editing: null, entryRetryKey: 'entry-key', updateDraftProtection() {}, action(_button, work) { job = work().catch(() => {}); }, api: () => new Promise((_resolve, refuse) => { reject = refuse; }) };
    runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
  runInNewContext(handler, context); submit({ preventDefault() {} }); assert.equal(doc.activeElement, body);
    if (deliberate) doc.activeElement = other;
    reject(new Error('The save was not confirmed.')); await job;
    assert.equal(doc.activeElement, deliberate ? other : button); assert.equal(restores, deliberate ? 0 : 1); assert.equal(nodes['entry-body'].value, 'Exact notes');
  }
});


test('a refused notebook save restores its disabled trigger only if the dialog remains open and focus fell to body', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const handlers = source.slice(source.indexOf('let notebookSaving'), source.indexOf("$('sync').addEventListener"));
  for (const state of ['body', 'deliberate', 'dismissed']) {
    const callbacks = new Map(), nodes = new Map(), body = {}, other = {}, doc = { body }; let job, refuse, restores = 0;
    const get = id => { if (!nodes.has(id)) nodes.set(id, { value: id === 'notebook-name' ? 'Original name' : '', isConnected: true, hidden: true,
      get disabled() { return this.off; }, set disabled(value) { this.off = value; if (value && doc.activeElement === this) doc.activeElement = body; },
      addEventListener: (event, callback) => callbacks.set(`${id}:${event}`, callback), setAttribute() {}, removeAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; }, focus() { doc.activeElement = this; restores++; } }); return nodes.get(id); };
    const context = { updateDraftProtection() {}, $: get, document: doc, crypto: { randomUUID: () => 'notebook-key' }, formDirty: false, action(_button, work) { job = work(); },
      api: () => new Promise((_resolve, reject) => { refuse = reject; }), notify() {} };
    runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
    runInNewContext(handlers, context); callbacks.get('new-notebook:click')(); doc.activeElement = get('create-notebook');
    callbacks.get('notebook-form:submit')({ preventDefault() {} }); assert.equal(doc.activeElement, body);
    if (state === 'deliberate') doc.activeElement = other; if (state === 'dismissed') callbacks.get('cancel-notebook:click')();
    refuse(Object.assign(new Error('Actual refusal.'), { status: 400 })); await job;
    assert.equal(restores, state === 'body' ? 1 : 0); assert.equal(doc.activeElement, state === 'body' ? get('create-notebook') : state === 'deliberate' ? other : body);
  }
});


test('risk validation associates external error and scope descriptions while preserving concise field labels', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('const requiredRiskFields'), source.indexOf('function ensureOption('));
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, { id, validity: { valid: false, valueMissing: true }, setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } }); return nodes.get(id); };
  const context = { $: get, snapshot: { settings: { executionEnabled: false } }, riskValidationActive: true };
  runInNewContext(functions, context); assert.equal(context.renderRiskValidation(), get('max-order'));
  for (const id of ['max-order', 'max-ticket', 'max-leverage']) {
    assert.equal(get(id)['aria-invalid'], 'true'); assert.equal(get(`${id}-error`).hidden, false);
    assert.equal(get(id)['aria-describedby'], `${id}-error${id === 'max-leverage' ? ' max-leverage-scope' : ''}`);
    get(id).validity = { valid: true };
  }
  assert.equal(context.renderRiskValidation(), null); assert.equal(get('max-order')['aria-describedby'], undefined);
  assert.equal(get('max-leverage')['aria-describedby'], 'max-leverage-scope'); assert.equal(get('max-leverage-error').hidden, true);
});


test('local entry create/edit retain the exact committed intent through lost reply and replay auth failures', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8'), { workspace, note } = await import('./helpers.mjs');
  for (const mode of ['create', 'edit']) {
    const w = await workspace(); try {
      const original = mode === 'edit' ? w.store.createEntry(note(w.store)) : null, baseCount = w.store.entries().length;
      let submit, job, saved, requestCount = 0; const requests = [], notices = [], nodes = new Map(), doc = { activeElement: {}, body: {}, querySelector: () => ({ focus() {} }) };
      const get = id => { if (!nodes.has(id)) nodes.set(id, { id, value: ({ 'entry-notebook': w.store.notebooks()[0].id, 'entry-title': 'Exact original title', 'entry-body': 'Exact submitted research', 'entry-status': 'watching', 'entry-signal': '' })[id] ?? '', hidden: false, disabled: false, dataset: {},
        setAttribute() {}, removeAttribute() {}, focus() {}, contains: () => false, addEventListener(_event, callback) { if (id === 'entry-form') submit = callback; } }); return nodes.get(id); };
      get('entry-form').elements = ['entry-notebook', 'entry-title', 'entry-body', 'entry-status', 'entry-signal', 'entry-save', 'cancel-edit', 'insert-ticket', 'insert-close-ticket'].map(get);
      const context = { updateDraftProtection() {}, $: get, document: doc, entrySaving: false, entryIntent: null, entrySavePendingMessage: 'The original save is unconfirmed.', entryRetryKey: 'stable-original-entry', editing: original, selected: null, snapshot: { entries: original ? [original] : [] }, crypto: { randomUUID: () => 'new-intent-key' },
        updateDraftProtection() {}, showSelectedEntry() {}, renderEntries() {}, notify: message => notices.push(message), load: async () => { throw new Error('Readback failed after confirmed reply.'); }, closeEditor() { get('editor').hidden = true; },
        action(_button, work) { job = work().catch(error => notices.push(error.message)); },
        api: async (path, body, headers) => {
          requests.push({ path, body: JSON.parse(JSON.stringify(body)), headers: { ...headers } }); requestCount++;
          if (requestCount === 2 || requestCount === 3) throw Object.assign(new Error('The current session cannot read this route.'), { status: requestCount === 2 ? 401 : 404 });
          const input = JSON.parse(JSON.stringify(body));
          saved = mode === 'edit' ? w.store.updateEntry(original.id, input, headers['Idempotency-Key']) : w.store.createEntry(input, headers['Idempotency-Key']);
          if (requestCount === 1) throw new TypeError('The committed reply was lost.');
          return saved;
        } };
      runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
      runInNewContext(source.slice(source.indexOf('function renderEntrySaveState('), source.indexOf('function editorValues(')), context);
      runInNewContext(source.slice(source.indexOf("$('entry-form').addEventListener('submit'"), source.indexOf('let notebookSaving')), context);
      const fire = async () => { submit({ preventDefault() {} }); await job; };
      await fire(); assert.equal(get('entry-body').readOnly, true, JSON.stringify({ notices, intent: context.entryIntent, requests })); assert.equal(get('entry-notebook').disabled, true); assert.equal(get('entry-save').textContent, 'Retry save');
      get('entry-body').value = 'Programmatic changed text must not alter original retry';
      for (let i = 0; i < 2; i++) { await fire(); assert.equal(get('entry-body').readOnly, true); assert.equal(context.entryIntent.uncertain, true); }
      await fire(); for (const request of requests) assert.deepEqual(request, requests[0]);
      assert.equal(context.entryIntent, null); assert.equal(get('entry-body').readOnly, false); assert.equal(w.store.entries().length, baseCount + (mode === 'create' ? 1 : 0));
      assert.equal(w.store.entry(saved.id).version, mode === 'create' ? 1 : 2); assert.equal(w.store.entry(saved.id).body, 'Exact submitted research');
      assert.ok(notices.some(message => /Entry saved, but the list could not refresh/.test(message))); assert.equal(w.store.all('attempt').length, 0);
    } finally { await w.close(); }
  }
});

test('notebook auth and route refusals after an uncertain create preserve its original identity until confirmation', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const callbacks = new Map(), nodes = new Map(), requests = []; let job, key = 0;
  const get = id => { if (!nodes.has(id)) nodes.set(id, { id, value: id === 'notebook-name' ? 'Original name' : '', hidden: false, setAttribute() {}, removeAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener(event, callback) { callbacks.set(`${id}:${event}`, callback); } }); return nodes.get(id); };
  const context = { updateDraftProtection() {}, $: get, document: { activeElement: {}, body: {} }, crypto: { randomUUID: () => `key-${++key}` }, formDirty: false, notify() {}, load: async () => {}, action(_button, work) { job = work(); },
    api: async (path, body, headers) => { requests.push({ path, body: { ...body }, headers: { ...headers } }); if (requests.length === 1) throw new SyntaxError('The committed reply was truncated.'); if (requests.length < 4) throw Object.assign(new Error('Current authentication or route refusal.'), { status: requests.length === 2 ? 401 : 404 }); return { id: 'saved-notebook' }; } };
  runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
  runInNewContext(source.slice(source.indexOf('let notebookSaving'), source.indexOf("$('sync').addEventListener")), context);
  callbacks.get('new-notebook:click')();
  for (let i = 0; i < 4; i++) { callbacks.get('notebook-form:submit')({ preventDefault() {} }); await job; if (i < 3) assert.equal(get('notebook-name').readOnly, true); }
  for (const request of requests) assert.deepEqual(request, requests[0]); assert.equal(key, 1); assert.equal(get('notebook-name').readOnly, false);
});


test('unconfirmed local entry stays copyable and cannot be closed or discarded even when its unchanged fields match the base', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const callbacks = new Map(), nodes = new Map(), messages = [], base = { body: 'Original exact text' };
  const get = id => { if (!nodes.has(id)) nodes.set(id, { id, value: id === 'entry-body' ? base.body : '', hidden: false, selectionStart: 3, selectionEnd: 9, close() { this.closed = true; }, addEventListener(event, callback) { callbacks.set(`${id}:${event}`, callback); } }); return nodes.get(id); };
  const intent = { path: '/api/entries/original', body: { body: base.body }, key: 'original-key', uncertain: true };
  const context = { $: get, entryIntent: intent, entrySaving: false, editorBase: base, localDraftDirty: () => false, notify: message => messages.push(message), editorValues: () => base };
  runInNewContext(source.slice(source.indexOf('const entrySavePendingMessage'), source.indexOf('function editorValues(')), context);
  runInNewContext(source.slice(source.indexOf('function editorDirty('), source.indexOf('function protectDraftOnLeave(')), context);
  runInNewContext(source.slice(source.indexOf('function closeEditor('), source.indexOf('function insertTicket(')), context);
  runInNewContext(source.slice(source.indexOf("$('cancel-edit').addEventListener"), source.indexOf("$('keep-writing').addEventListener")), context);
  runInNewContext(source.slice(source.indexOf("$('discard-writing').addEventListener"), source.indexOf("$('entry-form').addEventListener('submit'")), context);
  context.renderEntrySaveState(); assert.equal(context.editorDirty(), true); assert.equal(get('entry-body').readOnly, true); assert.equal(get('entry-body').disabled, undefined);
  assert.match(get('entry-save-status').textContent, /may already be stored.*Retry save.*copy/); assert.equal(get('entry-save-status').hidden, false);
  callbacks.get('cancel-edit:click')(); callbacks.get('discard-writing:click')(); context.closeEditor();
  assert.equal(get('editor').hidden, false); assert.equal(context.entryIntent, intent); assert.equal(context.editorBase, base); assert.equal(get('entry-body').value, base.body);
  assert.equal(get('entry-body').selectionStart, 3); assert.equal(get('entry-body').selectionEnd, 9); assert.equal(messages.length, 3);
});

test('initial local save refusals distinguish definite validation/version rejection from timeout or retry-identity conflict', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8'), context = {};
  runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
  for (const status of [400, 401, 403, 404, 422]) assert.equal(context.initialLocalSaveRefusal({ status, message: 'Definitive refusal.' }), true);
  assert.equal(context.initialLocalSaveRefusal({ status: 409, message: 'Entry changed. Read its latest version before editing.' }), true);
  for (const status of [408, 500, undefined]) assert.equal(context.initialLocalSaveRefusal({ status }), false);
  assert.equal(context.initialLocalSaveRefusal({ status: 409, message: 'Retry key was used for different content.' }), false);
});

test('notebook presentation sorts names stably without changing the source array; narrow settings order matches its DOM', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8'), css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8'), html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const next = { notebooks: [{ name: 'Zulu', origin: 'local', id: '1' }, { name: 'Alpha', origin: 'local', id: '3' }, { name: 'Alpha', origin: 'local', id: '2' }] }, before = JSON.stringify(next);
  const statement = source.match(/  snapshot = \{ \.\.\.next, notebooks:[^\n]+/)[0], context = { next }; runInNewContext(statement, context);
  assert.equal(context.snapshot.notebooks.map(row => row.id).join(','), '2,3,1'); assert.equal(JSON.stringify(next), before);
  assert.match(css, /\.listener-body:has\(>\.listener-configuration:not\(\[hidden\]\)\)\{grid-template-areas:"primary" "secondary" "config"\}/);
  assert.ok(html.indexOf('class="review-desk"') < html.indexOf('class="listener-secondary"')); assert.ok(html.indexOf('class="listener-secondary"') < html.indexOf('id="listener-configuration"'));
  assert.match(css, /@media\(min-width:1200px\)[\s\S]*?grid-template-areas:"primary config" "secondary config"/);
  assert.match(css, /\.nav-button:focus-visible\{outline-offset:-3px\}/);
  assert.match(html, /<label for="min-volume">Min 24h volume<span class="sr-only"> in USD<\/span><\/label><span class="affix">/);
});


test('an initial definite entry refusal unlocks correction while timeout and retry-content conflict retain the original intent', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  for (const [status, message, retained] of [[400, 'Invalid title.', false], [409, 'Entry changed. Read its latest version before editing.', false], [408, 'Timed out.', true], [409, 'Retry key was used for different content.', true]]) {
    const nodes = new Map(); let submit, job, keys = 0;
    const get = id => { if (!nodes.has(id)) nodes.set(id, { value: ({ 'entry-notebook': 'book', 'entry-title': 'Draft', 'entry-body': 'Notes', 'entry-status': 'watching', 'entry-signal': '' })[id] ?? '', disabled: false, hidden: false,
      setAttribute() {}, removeAttribute() {}, addEventListener(_event, callback) { if (id === 'entry-form') submit = callback; } }); return nodes.get(id); };
    get('entry-form').elements = ['entry-notebook', 'entry-title', 'entry-body', 'entry-status', 'entry-signal', 'entry-save', 'cancel-edit', 'insert-ticket', 'insert-close-ticket'].map(get);
    const context = { $: get, entryIntent: null, entrySaving: false, editing: null, entryRetryKey: 'initial-key', document: { activeElement: {}, body: {} }, crypto: { randomUUID: () => `fresh-${++keys}` }, updateDraftProtection() {},
      action(_button, work) { job = work().catch(() => {}); }, api: async () => { throw Object.assign(new Error(message), { status }); } };
    runInNewContext(source.slice(source.indexOf('const entrySavePendingMessage'), source.indexOf('function editorValues(')), context);
    runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
    runInNewContext(source.slice(source.indexOf("$('entry-form').addEventListener('submit'"), source.indexOf('let notebookSaving')), context);
    submit({ preventDefault() {} }); await job;
    assert.equal(get('entry-body').readOnly, retained); assert.equal(get('entry-notebook').disabled, retained); assert.equal(Boolean(context.entryIntent), retained);
    assert.equal(context.entryRetryKey, retained ? 'initial-key' : 'fresh-1'); assert.equal(get('entry-body').value, 'Notes');
  }
});


test('pending and uncertain notebook requests reuse unload and native quit protection until actually confirmed', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8'), { createDraftExitGuard } = await import('../desktop/policy.mjs');
  for (const entryDirty of [false, true]) {
    const callbacks = new Map(), nodes = new Map(), listeners = new Map(), jobs = [], nativeReports = []; let requests = 0, release, entryStillDirty = entryDirty, exits = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const native = createDraftExitGuard({ confirmDiscard: async () => false });
    const get = id => { if (!nodes.has(id)) nodes.set(id, { value: id === 'notebook-name' ? 'Original request' : '', hidden: false, setAttribute() {}, removeAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener(event, callback) { callbacks.set(`${id}:${event}`, callback); } }); return nodes.get(id); };
    const context = { updateDraftProtection() {}, $: get, document: { activeElement: {}, body: {} }, desktop: { setDraftDirty(value) { nativeReports.push(value); native.reportDirty(value); return true; } },
      window: { addEventListener(type, callback) { listeners.set(type, callback); }, removeEventListener(type) { listeners.delete(type); } }, reportedDraftDirty: undefined, entrySaving: false, editorDirty: () => entryStillDirty,
      crypto: { randomUUID: () => 'protected-notebook-key' }, formDirty: false, notify() {}, action(_button, work) { jobs.push(work()); },
      api: async () => { requests++; if (requests === 1) { await pending; throw new Error('The original committed response was lost.'); } if (requests === 2) throw Object.assign(new Error('Replay authentication refused.'), { status: 401 }); return { id: 'original-notebook' }; },
      load: async () => { assert.equal(listeners.has('beforeunload'), entryStillDirty, 'A confirmed write must not remain uncertain merely because readback is pending.'); } };
    runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
    const guardStart = source.indexOf('function hasProtectedDraft(') >= 0 ? source.indexOf('function hasProtectedDraft(') : source.indexOf('function protectDraftOnLeave(');
    runInNewContext(source.slice(guardStart, source.indexOf('function keepDraftVisible(')), context);
    runInNewContext(source.slice(source.indexOf('let notebookSaving'), source.indexOf("$('sync').addEventListener")), context);
    callbacks.get('new-notebook:click')(); const submit = () => callbacks.get('notebook-form:submit')({ preventDefault() {} });
    submit(); assert.equal(nativeReports.at(-1), true); assert.equal(listeners.has('beforeunload'), true); callbacks.get('cancel-notebook:click')();
    let prevented = false; listeners.get('beforeunload')({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
    assert.equal(await native.run('quit', async () => { exits++; }), false); assert.equal(exits, 0);
    release(); await jobs[0]; assert.equal(nativeReports.at(-1), true); assert.equal(listeners.has('beforeunload'), true);
    callbacks.get('new-notebook:click')(); submit(); await jobs[1]; assert.equal(nativeReports.at(-1), true, 'A later authentication refusal cannot drop an uncertain operation.');
    submit(); await jobs[2]; assert.equal(nativeReports.at(-1), entryDirty); assert.equal(listeners.has('beforeunload'), entryDirty);
    entryStillDirty = false; context.updateDraftProtection(); assert.equal(nativeReports.at(-1), false);
    assert.equal(await native.run('restart', async () => { exits++; }), true); assert.equal(exits, 1);
  }
});

test('an initial definitive notebook refusal releases only its own exit protection', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const callbacks = new Map(), nodes = new Map(), reports = []; let job;
  const get = id => { if (!nodes.has(id)) nodes.set(id, { value: 'Refused notebook', setAttribute() {}, removeAttribute() {}, showModal() { this.open = true; }, addEventListener(event, callback) { callbacks.set(`${id}:${event}`, callback); } }); return nodes.get(id); };
  const context = { updateDraftProtection() {}, $: get, document: { activeElement: {}, body: {} }, crypto: { randomUUID: () => 'refused-key' }, formDirty: false, entrySaving: false, editorDirty: () => false, reportedDraftDirty: undefined,
    desktop: { setDraftDirty(value) { reports.push(value); return true; } }, window: { addEventListener() {}, removeEventListener() {} }, notify() {}, action(_button, work) { job = work(); }, api: async () => { throw Object.assign(new Error('Invalid notebook name.'), { status: 400 }); } };
  runInNewContext(source.slice(source.indexOf('function initialLocalSaveRefusal('), source.indexOf('async function action(')), context);
  const guardStart = source.indexOf('function hasProtectedDraft(') >= 0 ? source.indexOf('function hasProtectedDraft(') : source.indexOf('function protectDraftOnLeave(');
  runInNewContext(source.slice(guardStart, source.indexOf('function keepDraftVisible(')), context);
  runInNewContext(source.slice(source.indexOf('let notebookSaving'), source.indexOf("$('sync').addEventListener")), context);
  callbacks.get('new-notebook:click')(); callbacks.get('notebook-form:submit')({ preventDefault() {} }); await job;
  assert.equal(reports[0], true); assert.equal(reports.at(-1), false); assert.equal(get('notebook-name').readOnly, false);
});

test('native exit warning covers unconfirmed saves honestly and interval help belongs to its selector', async () => {
  const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8'), html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  let confirm, shown;
  const context = { window: { show() {}, isDestroyed: () => false }, createDraftExitGuard: ({ confirmDiscard }) => { confirm = confirmDiscard; return {}; }, dialog: { async showMessageBox(_window, options) { shown = options; return { response: 0 }; } } };
  runInNewContext(main.slice(main.indexOf('const draftExit = createDraftExitGuard('), main.indexOf('async function prepareExit(')), context);
  assert.equal(await confirm('restart', false), false); assert.match(shown.message, /Save or confirm/); assert.match(shown.detail, /retry information.*cannot undo.*already completed/i); assert.equal(shown.defaultId, 0); assert.equal(shown.cancelId, 0);
  assert.doesNotMatch(shown.detail, /only the unsaved writing/);
  assert.match(html, /<div class="interval-field"><label for="interval">Wait between checks<\/label><select id="interval" aria-describedby="interval-hint">[\s\S]*?<\/select><p id="interval-hint" class="hint">The interval starts after the previous check finishes\.<\/p><\/div>/);
  assert.equal((html.match(/The interval starts after the previous check finishes/g) ?? []).length, 1);
});
