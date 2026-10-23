import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPresentation, updatePresentation, modelPresentation } from '../public/desktop-ui.mjs';

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

test('displayed submission and uncertain results never imply an order was filled', async () => {
  const { listenerResult, matchesResultFilter } = await import('../public/desktop-ui.mjs');
  for (const status of ['submitted', 'partial', 'pending', 'unknown']) {
    const entry = { ticket: { ticket: {} }, listener: { status } };
    assert.doesNotMatch(listenerResult(entry).label, /placed|filled|complete/);
    assert.equal(matchesResultFilter(entry, status === 'submitted' || status === 'partial' ? 'placed' : 'open'), true);
  }
  const note = { listener: { status: 'observed', decision: 'review' } };
  assert.equal(listenerResult(note).label, 'needs attention');
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
  assert.deepEqual([complete.accepted, complete.verdict], [true, { label: 'needs attention', tone: 'warn', reason: 'Needs a quantity.' }]);
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
