import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { accountPresentation, updatePresentation, modelPresentation } from '../public/desktop-ui.mjs';

test('entry saves lock the actual form handler until acceptance and an older refresh cannot unlock a newer save', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("$('entry-form').addEventListener('submit'"), source.indexOf("$('notebook-form').addEventListener('submit'"));
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const first = deferred(), refresh = deferred(), second = deferred(), requests = [], actions = [], errors = [];
  const controls = ['entry-notebook', 'entry-title', 'entry-body', 'entry-status', 'entry-signal'].map(id => ({ id, value: ({ 'entry-notebook': 'book', 'entry-title': 'Draft', 'entry-body': 'Exact submitted notes', 'entry-status': 'watching' })[id] ?? '', disabled: false }));
  const disabled = { disabled: true }, attributes = new Map(), nodes = Object.fromEntries(controls.map(control => [control.id, control]));
  const focus = { dataset: { rowKey: 'local:saved-note' }, focus() {} };
  let submit, closes = 0;
  nodes['entry-form'] = { elements: [...controls, disabled], setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key), addEventListener: (_event, callback) => { submit = callback; } };
  nodes['entry-list'] = { contains: () => false }; nodes['new-entry'] = focus;
  const context = {
    $: id => nodes[id], entrySaving: false, editing: null, entryRetryKey: 'original-retry-key', selected: null,
    document: { activeElement: focus, querySelector: () => focus },
    action: (_button, work) => { const promise = work().catch(error => errors.push(error.message)); actions.push(promise); },
    api: (path, body, headers) => { requests.push({ path, body, headers }); return requests.length === 1 ? first.promise : second.promise; },
    updateDraftProtection() {}, showSelectedEntry() {}, renderEntries() {}, notify() {},
    closeEditor: () => { assert.equal(context.entrySaving, false); closes++; }, load: () => refresh.promise,
  };
  runInNewContext(handler, context);
  const event = { preventDefault() {} };
  submit(event);
  assert.equal(context.entrySaving, true); assert.equal(attributes.get('aria-busy'), 'true');
  assert.ok(nodes['entry-form'].elements.every(control => control.disabled));
  submit(event); assert.equal(requests.length, 1, 'A second submit cannot create another request.');
  assert.equal(requests[0].body.body, 'Exact submitted notes');
  first.resolve({ id: 'saved-note', version: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.entrySaving, false); assert.equal(attributes.has('aria-busy'), false); assert.equal(closes, 1);
  assert.ok(controls.every(control => !control.disabled)); assert.equal(disabled.disabled, true);
  submit(event); assert.equal(context.entrySaving, true);
  refresh.resolve(); await actions[0];
  assert.equal(context.entrySaving, true, 'Finishing the older refresh must not release the newer form lock.');
  assert.ok(controls.every(control => control.disabled));
  second.reject(new Error('Save could not be confirmed.')); await actions[1];
  assert.equal(context.entrySaving, false); assert.equal(attributes.has('aria-busy'), false);
  assert.ok(controls.every(control => !control.disabled)); assert.equal(disabled.disabled, true);
  assert.equal(nodes['entry-body'].value, 'Exact submitted notes'); assert.equal(context.entryRetryKey, 'original-retry-key');
  assert.deepEqual(errors, ['Save could not be confirmed.']);
});

test('a saving clean entry cannot be replaced, closed or navigated away from', async () => {
  const source = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const boundaries = [['function showEditor(', '// Picking another entry'], ['function leaveEditor()', 'function closeEditor('], ['function closeEditor(', 'function insertTicket('], ['function switchView(', "\ndocument.querySelectorAll('[data-view]')"]];
  const guards = boundaries.map(([start, end]) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))).join('\n');
  const notices = [], context = { entrySaving: true, editorDirty: () => false, notify: message => notices.push(message), $() { throw new Error('A saving editor must not be replaced or hidden.'); } };
  runInNewContext(guards, context);
  context.showEditor(); assert.equal(context.leaveEditor(), false); context.closeEditor(); context.switchView('activity');
  assert.equal(notices.length, 4); assert.ok(notices.every(message => message.includes('still saving')));
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
  assert.equal(modelPresentation({ state: 'error' }).label, 'Retry model setup');
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
    assert.equal(view.accepted, false); assert.equal(view.verdict, null); assert.match(view.note, /not accepted|Nothing is accepted/);
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
  assert.match(streaming.note, /Nothing is accepted/);
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
