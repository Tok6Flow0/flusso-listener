import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEntryHandoff, entryInScope, scopeMismatch } from '../src/handoff.mjs';
import { createListener } from '../src/listener.mjs';
import { startServer } from '../src/server.mjs';
import { workspace, enable, note, ticket, fakeCloud, now } from './helpers.mjs';

test('handoff shares exact source/notebook/heading selection with actual Listener admission', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async () => { calls++; throw new Error('Out-of-scope ticket reached dispatch.'); } }), clock: () => now });
  try {
    enable(w.store, { section: 'Exact heading' }); listener.start();
    const entry = w.store.createEntry(note(w.store, { body: ticket() }));
    assert.equal(scopeMismatch(entry, w.store.settings()), 'section');
    assert.equal(entryInScope(entry, w.store.settings()), false);
    assert.equal(describeEntryHandoff({ entry, settings: w.store.settings(), now }).code, 'out_of_scope');
    await listener.tick(); assert.equal(calls, 0); assert.equal(w.store.all('activity').length, 0);
    const selected = { ...entry, body: '# exact HEADING\n' + entry.body };
    assert.equal(entryInScope(selected, w.store.settings()), true);
    assert.equal(scopeMismatch({ ...selected, origin: 'cloud' }, w.store.settings()), 'source');
    assert.equal(scopeMismatch({ ...selected, notebookId: 'other' }, w.store.settings()), 'notebook');
  } finally { await listener.stop(); await w.close(); }
});

test('handoff explains reviewed research, startup baseline, malformed/stale tickets, and current waiting without writing', async () => {
  const w = await workspace();
  try {
    enable(w.store);
    const entry = w.store.createEntry(note(w.store));
    const describe = (additions = {}, state = {}) => describeEntryHandoff({ entry: { ...entry, ...additions }, settings: w.store.settings(), now, ...state });
    const before = JSON.stringify(['settings', 'entry', 'checkpoint', 'attempt', 'activity'].map(kind => w.store.all(kind)));
    assert.equal(describe().code, 'research_only'); assert.match(describe().reason, /No order or close ticket/);
    const reviewed = describe({ status: 'reviewed', body: '```json\n{"proposedOrders":[]}\n```' });
    assert.equal(reviewed.code, 'reviewed'); assert.equal(reviewed.kind, 'research'); assert.match(reviewed.reason, /No order or close ticket/);
    assert.equal(describe({}, { checkpoint: { version: entry.version, state: 'baseline' } }).code, 'baselined');
    assert.equal(describe({}, { checkpoint: { version: entry.version - 1, state: 'baseline' } }).code, 'research_only');
    assert.equal(describe({ body: '```flusso-orders\ninvalid\n```' }).code, 'malformed_ticket');
    assert.equal(describe({ body: ticket(), updatedAtUtc: new Date(now - 86400000).toISOString() }).code, 'stale_ticket');
    assert.equal(describe({ body: ticket() }).code, 'awaiting_check');
    assert.equal(describe({ body: ticket() }, { activity: { version: entry.version, status: 'waiting', reason: 'A complete cloud read is required.' } }).reason, 'A complete cloud read is required.');
    assert.equal(describe({ body: ticket() }, { activity: { version: entry.version - 1, status: 'waiting', reason: 'Old reason.' } }).code, 'awaiting_check');
    assert.equal(JSON.stringify(['settings', 'entry', 'checkpoint', 'attempt', 'activity'].map(kind => w.store.all(kind))), before);
  } finally { await w.close(); }
});

test('existing private status response adds handoff diagnostics without checking or submitting entries', async () => {
  const w = await workspace(); let actions = 0, app;
  try {
    enable(w.store, { executionEnabled: false });
    w.store.createEntry(note(w.store, { status: 'reviewed' }));
    w.store.createEntry(note(w.store, { body: ticket() }));
    app = await startServer({ store: w.store, cloud: fakeCloud(), listener: { status: () => ({}), tick: async () => { actions++; }, refresh: () => { actions++; } }, checkModel: async () => ({ installed: true }), clock: () => now });
    const unlocked = await fetch(app.origin + '/api/bootstrap', { method: 'POST', headers: { Origin: app.origin, Authorization: 'Bearer ' + new URL(app.url).hash.slice(1) } });
    const cookie = unlocked.headers.get('set-cookie').split(';')[0];
    const before = JSON.stringify(['settings', 'entry', 'checkpoint', 'attempt', 'activity'].map(kind => w.store.all(kind)));
    const response = await fetch(app.origin + '/api/status', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.entries.find(row => !row.ticket).handoff.code, 'reviewed');
    const ready = status.entries.find(row => row.ticket);
    assert.equal(ready.handoff.code, 'waiting'); assert.match(ready.handoff.reason, /Auto-trade is off/);
    assert.equal(ready.listener, null); assert.equal(ready.ticket.ticket.id, 'kaia-2026-10-12T01');
    assert.equal(actions, 0); assert.equal(JSON.stringify(['settings', 'entry', 'checkpoint', 'attempt', 'activity'].map(kind => w.store.all(kind))), before);
  } finally { await app?.close(); await w.close(); }
});

test('aged unknown delivery stays unconfirmed through readback, opt-out, changed scope, reviewed status and a baseline', async () => {
  const w = await workspace(); let clock = now, submissions = 0, reads = 0, app;
  const cloud = fakeCloud({ submitOrders: async () => { submissions++; return { status: 'unknown', lines: [], message: 'Synthetic lost response.' }; }, reconcileOrders: async () => { reads++; return null; } });
  const listener = createListener({ store: w.store, cloud, clock: () => clock });
  try {
    enable(w.store); listener.start();
    const entry = w.store.createEntry(note(w.store, { body: ticket() }));
    await listener.tick(); assert.equal(submissions, 1);
    clock += (w.store.settings().maxSignalAgeSeconds + 1) * 1000;
    await listener.tick(); assert.equal(submissions, 1); assert.equal(reads, 1, 'Age must not turn unknown delivery into a new submission.');
    const attempts = w.store.all('attempt'), activity = w.store.all('activity')[0];
    const aged = describeEntryHandoff({ entry, settings: w.store.settings(), attempts, activity, now: clock });
    assert.equal(aged.code, 'unconfirmed'); assert.match(aged.reason, /may have been sent/); assert.doesNotMatch(aged.reason, /was not placed|No order has been sent/);
    w.store.saveSettings({ ...w.store.settings(), enabled: false, executionEnabled: false, source: 'cloud' });
    for (const status of ['watching', 'reviewed', 'closed']) {
      const result = describeEntryHandoff({ entry: { ...entry, status }, settings: w.store.settings(), attempts, checkpoint: { version: entry.version, state: 'baseline' }, now: clock });
      assert.equal(result.code, 'unconfirmed'); assert.equal(result.context.inScope, false);
      assert.equal(result.context.entryStatus, status); assert.equal(result.context.listenerEnabled, false); assert.equal(result.context.checkpointState, 'baseline');
      assert.doesNotMatch(result.reason, /was not placed|No order has been sent/);
    }
    // Simulate the durable-claim crash window: the status endpoint must use the
    // attempt even if no sending/unknown Activity update survived.
    for (const row of w.store.all('activity')) w.store.delete('activity', row.id);
    app = await startServer({ store: w.store, cloud, listener, checkModel: async () => ({ installed: true }), clock: () => clock });
    const unlocked = await fetch(app.origin + '/api/bootstrap', { method: 'POST', headers: { Origin: app.origin, Authorization: 'Bearer ' + new URL(app.url).hash.slice(1) } });
    const cookie = unlocked.headers.get('set-cookie').split(';')[0];
    const before = JSON.stringify(['settings', 'entry', 'checkpoint', 'attempt', 'activity'].map(kind => w.store.all(kind)));
    const status = await fetch(app.origin + '/api/status', { headers: { Cookie: cookie } }).then(response => response.json());
    assert.equal(status.entries[0].handoff.code, 'unconfirmed'); assert.equal(status.entries[0].listener, null);
    assert.equal(status.entries[0].handoff.context.inScope, false); assert.equal(status.entries[0].handoff.context.listenerEnabled, false);
    assert.equal(submissions, 1); assert.equal(reads, 1);
    assert.equal(JSON.stringify(['settings', 'entry', 'checkpoint', 'attempt', 'activity'].map(kind => w.store.all(kind))), before);
  } finally { await app?.close(); await listener.stop(); await w.close(); }
});

test('same-revision retained delivery outranks age while unrelated attempts and old activity cannot override current admission', async () => {
  const w = await workspace();
  try {
    enable(w.store);
    const entry = w.store.createEntry(note(w.store, { body: ticket() }));
    const attempt = { id: 'retained-fixture', kind: 'orders', origin: entry.origin, entryId: entry.id, version: entry.version, status: 'unknown' };
    const describe = (attempts, activity = null) => describeEntryHandoff({ entry, settings: w.store.settings(), attempts, activity, now: now + 86400000 });
    for (const [status, code] of [['pending', 'unconfirmed'], ['unknown', 'unconfirmed'], ['submitted', 'submitted'], ['partial', 'partial'], ['blocked', 'blocked'], ['resolved', 'resolved'], ['failed', 'unconfirmed']]) {
      const result = describe([{ ...attempt, status }]);
      assert.equal(result.code, code); assert.doesNotMatch(result.reason, /was not placed|No order has been sent/);
    }
    assert.equal(describe([{ ...attempt, status: 'blocked' }, attempt]).code, 'unconfirmed', 'Uncertainty wins if inconsistent attempts coexist.');
    for (const unrelated of [{ ...attempt, version: entry.version + 1 }, { ...attempt, origin: 'cloud' }, { ...attempt, entryId: 'different-entry' }]) assert.equal(describe([unrelated]).code, 'stale_ticket');
    assert.equal(describe([], { version: entry.version, status: 'sending' }).code, 'sending');
    assert.equal(describe([], { version: entry.version, status: 'unknown' }).code, 'unconfirmed');
    assert.equal(describe([], { version: entry.version - 1, status: 'unknown' }).code, 'stale_ticket');
  } finally { await w.close(); }
});
