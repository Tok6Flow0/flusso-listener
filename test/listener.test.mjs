import test from 'node:test';
import assert from 'node:assert/strict';
import { createListener } from '../src/listener.mjs';
import { workspace, note, ticket, hedge, signal, fakeCloud, enable, now, notebookId, accountId } from './helpers.mjs';

const candidate = async () => ({ decision: 'candidate', reason: 'Fixture match.' });
const noModel = async () => { throw new Error('The model must not read order tickets.'); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const sent = orders => ({ status: 'submitted', lines: orders.map(order => ({ ...order, status: 'submitted', orderId: null, riskCode: null, message: 'Sent.' })), message: null });

test('a new ticket is placed once across edits and copies, and its result is noted on the entry', async () => {
  const w = await workspace(); const calls = [];
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async attempt => { calls.push(attempt); return sent(attempt.orders); } }), classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start();
    const entry = w.store.createEntry(note(w.store, { body: ticket() })); await listener.tick(); assert.equal(calls.length, 1);
    assert.equal(calls[0].accountId, accountId); assert.match(calls[0].idempotencyKey, /^listener-[a-f\d]{64}$/);
    const noted = w.store.entry(entry.id);
    assert.equal(noted.status, 'reviewed'); assert.equal(noted.version, entry.version + 1);
    assert.match(noted.body, /## Listener result\n\n\*\*Placed\*\*/); assert.match(noted.body, /buy gate:KAIA_USDT 120 @ 0\.1234: sent/);
    assert.equal(w.store.get('checkpoint', `local:${entry.id}`).version, noted.version, 'Writing the result is not another decision');
    w.store.updateEntry(entry.id, { ...note(w.store), body: ticket() + '\nEdited prose.', version: noted.version }); await listener.tick(); assert.equal(calls.length, 1);
    w.store.createEntry(note(w.store, { body: ticket() })); await listener.tick(); assert.equal(calls.length, 1);
    const activity = w.store.all('activity').find(row => row.attemptId === calls[0].id);
    assert.equal(activity.status, 'submitted'); assert.match(activity.reason, /2 orders sent/);
  } finally { listener.stop(); await w.close(); }
});
test('starting up decides unactioned tickets inside the window and skips older ones', async () => {
  const w = await workspace(); const calls = []; let clock = now;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async attempt => { calls.push(attempt); return sent(attempt.orders); } }), classify: noModel, clock: () => clock });
  try {
    enable(w.store, { maxSignalAgeSeconds: 21600 });
    const old = w.store.createEntry(note(w.store, { body: ticket({ id: 'written-yesterday' }) }));
    clock = now + 7 * 3600000; // the app was closed for seven hours
    const recent = { ...note(w.store, { body: ticket({ id: 'written-while-closed' }) }) };
    const fresh = w.store.createEntry(recent);
    // createEntry stamps the store clock; move the old one outside the six-hour window.
    w.store.put('entry', `local:${old.id}`, { ...w.store.entry(old.id), updatedAtUtc: new Date(now - 3600000).toISOString(), createdAtUtc: new Date(now - 3600000).toISOString() });
    w.store.put('entry', `local:${fresh.id}`, { ...w.store.entry(fresh.id), updatedAtUtc: new Date(clock - 3600000).toISOString(), createdAtUtc: new Date(clock - 3600000).toISOString() });
    listener.start(); await listener.tick();
    assert.deepEqual(calls.map(call => call.ticketId), ['written-while-closed']);
    assert.equal(w.store.get('checkpoint', `local:${old.id}`).state, 'baseline');
  } finally { listener.stop(); await w.close(); }
});
test('a setup gap leaves the ticket unactioned until it is fixed, then it is decided', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async ({ orders }) => { calls++; return sent(orders); } }), classify: noModel, clock: () => now });
  try {
    enable(w.store, { executionEnabled: false }); listener.start();
    const entry = w.store.createEntry(note(w.store, { body: ticket({ id: 'set-up-later' }) })); await listener.tick();
    assert.equal(calls, 0); assert.equal(w.store.entry(entry.id).status, 'watching', 'Nothing is written while auto-trade is off');
    assert.equal(w.store.all('activity').find(row => row.entryId === entry.id).status, 'waiting');
    enable(w.store, { executionEnabled: true }); await listener.tick();
    assert.equal(calls, 1); assert.equal(w.store.entry(entry.id).status, 'reviewed');
  } finally { listener.stop(); await w.close(); }
});
test('a failed connection status read leaves an unclaimed ticket available for the next check', async () => {
  const w = await workspace(); let checks = 0, calls = 0;
  const cloud = fakeCloud({
    status: async () => {
      if (++checks === 1) throw new Error('Synthetic temporary vault failure.');
      return { connected: true, clientId: 'fixture-client', scopes: ['mcp:read', 'mcp:write'] };
    },
    submitOrders: async ({ orders }) => { calls++; return sent(orders); },
  });
  const listener = createListener({ store: w.store, cloud, classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start();
    const entry = w.store.createEntry(note(w.store, { body: ticket({ id: 'connection-recovers' }) }));
    await listener.tick();
    assert.equal(calls, 0); assert.equal(w.store.all('attempt').length, 0);
    assert.equal(w.store.get('checkpoint', `local:${entry.id}`), null);
    assert.equal(w.store.entry(entry.id).status, 'watching');
    assert.equal(w.store.all('activity')[0].status, 'waiting');
    assert.match(w.store.all('activity')[0].reason, /connection status is temporarily unavailable/);
    await listener.tick(); await listener.tick();
    assert.equal(calls, 1); assert.equal(w.store.all('attempt').length, 1);
    assert.equal(w.store.entry(entry.id).status, 'reviewed');
  } finally { await listener.stop(); await w.close(); }
});
test('a settings refresh during the pre-claim status read leaves the ticket waiting for current settings', async () => {
  const w = await workspace(), started = deferred(), finish = deferred(); let checks = 0, calls = 0;
  const cloud = fakeCloud({
    status: async () => {
      if (++checks === 1) { started.resolve(); await finish.promise; }
      return { connected: true, clientId: 'fixture-client', scopes: ['mcp:read', 'mcp:write'] };
    },
    submitOrders: async ({ orders }) => { calls++; return sent(orders); },
  });
  const listener = createListener({ store: w.store, cloud, classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start();
    const entry = w.store.createEntry(note(w.store, { body: ticket({ id: 'settings-refresh' }) }));
    const checking = listener.tick(); await started.promise;
    enable(w.store, { executionEnabled: false }); listener.refresh(); finish.resolve(); await checking;
    assert.equal(calls, 0); assert.equal(w.store.all('attempt').length, 0);
    assert.equal(w.store.get('checkpoint', `local:${entry.id}`), null);
    assert.equal(w.store.entry(entry.id).status, 'watching');
    assert.match(w.store.all('activity')[0].reason, /settings changed before dispatch/);
    await listener.tick(); assert.equal(calls, 0, 'The current off setting is enforced.');
    enable(w.store); listener.refresh(); await listener.tick(); await listener.tick();
    assert.equal(calls, 1); assert.equal(w.store.all('attempt').length, 1);
  } finally { finish.resolve(); await listener.stop(); await w.close(); }
});
test('stopping during the pre-claim status read does not consume the ticket on restart', async () => {
  const w = await workspace(), started = deferred(), finish = deferred(); let checks = 0, calls = 0;
  const cloud = fakeCloud({
    status: async () => {
      if (++checks === 1) { started.resolve(); await finish.promise; }
      return { connected: true, clientId: 'fixture-client', scopes: ['mcp:read', 'mcp:write'] };
    },
    submitOrders: async ({ orders }) => { calls++; return sent(orders); },
  });
  const listener = createListener({ store: w.store, cloud, classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start();
    const entry = w.store.createEntry(note(w.store, { body: ticket({ id: 'stopped-before-claim' }) }));
    const checking = listener.tick(); await started.promise;
    const stopping = listener.stop(); finish.resolve(); await stopping; await checking;
    assert.equal(calls, 0); assert.equal(w.store.all('attempt').length, 0);
    assert.equal(w.store.get('checkpoint', `local:${entry.id}`), null);
    listener.start(); await listener.tick(); await listener.tick();
    assert.equal(calls, 1); assert.equal(w.store.all('attempt').length, 1);
  } finally { finish.resolve(); await listener.stop(); await w.close(); }
});
test('a refused ticket is noted as not placed, and write-back can be turned off', async () => {
  const w = await workspace();
  const listener = createListener({ store: w.store, cloud: fakeCloud(), classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start();
    const refused = w.store.createEntry(note(w.store, { body: ticket({ id: 'venue-refuses' }) })); await listener.tick();
    assert.match(w.store.entry(refused.id).body, /\*\*Refused\*\*/); assert.match(w.store.entry(refused.id).body, /refused \(fixture · Fixture refusal\.\)/);
    enable(w.store, { writeBack: false });
    const quiet = w.store.createEntry(note(w.store, { body: ticket({ id: 'not-noted' }) })); await listener.tick();
    assert.equal(w.store.entry(quiet.id).status, 'watching'); assert.doesNotMatch(w.store.entry(quiet.id).body, /Listener result/);
  } finally { listener.stop(); await w.close(); }
});
test('a cloud ticket result is written back through Flusso and its new revision is not decided again', async () => {
  const w = await workspace(); const updates = []; let calls = 0;
  const cloudEntry = { ...note(w.store), body: ticket({ id: 'cloud-ticket' }), id: '00000000-0000-4000-8000-000000000044', notebookId, version: 3, createdAtUtc: new Date(now).toISOString(), updatedAtUtc: new Date(now).toISOString(), signal: null };
  let rows = [cloudEntry];
  const listener = createListener({ store: w.store, cloud: fakeCloud({
    readJournal: async () => ({ notebooks: [{ id: notebookId, name: 'Cloud', version: 1 }], entries: rows, complete: true }),
    submitOrders: async ({ orders }) => { calls++; return sent(orders); },
    updateJournalEntry: async ({ entry, body, status }) => { updates.push({ entry, body, status }); const next = { ...entry, body, status, version: entry.version + 1 }; rows = [next]; return next; },
  }), classify: noModel, clock: () => now });
  try {
    enable(w.store, { source: 'cloud', notebookIds: [notebookId] }); w.store.put('sync', 'baseline', { atUtc: new Date(now).toISOString() });
    listener.start(); await listener.tick();
    assert.equal(calls, 1); assert.equal(updates.length, 1);
    assert.equal(updates[0].status, 'reviewed'); assert.equal(updates[0].entry.version, 3); assert.match(updates[0].body, /## Listener result/);
    await listener.tick(); assert.equal(calls, 1); assert.equal(updates.length, 1);
  } finally { listener.stop(); await w.close(); }
});
test('ticket orders keep the owner risk limits and both legs share one release time', async () => {
  const w = await workspace(); let attempt;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async value => { attempt = value; return sent(value.orders); } }), classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start(); w.store.createEntry(note(w.store, { body: ticket() })); await listener.tick();
    assert.deepEqual(attempt.orders.map(order => order.conditions), [{ maxSlippagePct: 2, maxNotionalUsd: 50 }, { maxSlippagePct: 2, maxNotionalUsd: 50 }]);
    assert.equal(attempt.orders[0].placeAtUtc, attempt.orders[1].placeAtUtc);
    assert.equal(attempt.orders.map(order => order.instrumentId).join(), hedge.map(order => order.instrumentId).join());
  } finally { listener.stop(); await w.close(); }
});
test('prose, structured research and off auto-trade never place orders', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async () => { calls++; } }), classify: candidate, clock: () => now });
  try {
    enable(w.store); listener.start();
    w.store.createEntry(note(w.store)); w.store.createEntry(note(w.store, { signal: signal() }));
    await listener.tick(); assert.equal(calls, 0);
    enable(w.store, { executionEnabled: false }); w.store.createEntry(note(w.store, { body: ticket({ id: 'while-off' }) })); await listener.tick();
    assert.equal(calls, 0);
    assert.match(w.store.all('activity').find(row => row.decision === 'ticket').reason, /Auto-trade is off/);
    assert.equal(w.store.all('activity').find(row => row.decision === 'ticket').status, 'waiting');
  } finally { listener.stop(); await w.close(); }
});
test('a broken local model does not hold up an order ticket', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async ({ orders }) => { calls++; return sent(orders); } }), classify: async () => { throw new Error('The local model is unavailable.'); }, clock: () => now });
  try {
    enable(w.store); listener.start(); const prose = w.store.createEntry(note(w.store)); w.store.createEntry(note(w.store, { body: ticket() }));
    await listener.tick(); assert.equal(calls, 1);
    assert.equal(w.store.get('checkpoint', `local:${prose.id}`), null, 'The note is read again once the model works');
    assert.match(listener.status().lastError, /local model/);
  } finally { listener.stop(); await w.close(); }
});
test('invalid and stale tickets stay in Activity for review', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async () => { calls++; } }), classify: noModel, clock: () => now + 3600000 });
  try {
    enable(w.store, { maxSignalAgeSeconds: 900 }); listener.start();
    w.store.createEntry(note(w.store, { body: ticket({ id: 'stale' }) }));
    w.store.createEntry(note(w.store, { body: '```flusso-orders\n{"id":"invalid-identity","orders":[{"instrumentId":"BTC","side":"buy","quantity":1,"limitPrice":1}]}\n```' }));
    await listener.tick(); assert.equal(calls, 0);
    const reasons = w.store.all('activity').map(row => row.reason).join(' ');
    assert.match(reasons, /older than your signal age limit/); assert.match(reasons, /venue:instrument/);
  } finally { listener.stop(); await w.close(); }
});
test('an unconfirmed result pauses new tickets and uses only canonical readback, including while auto-trade is off', async () => {
  const w = await workspace(); const calls = [], reads = []; let answer = 'unknown';
  const cloud = fakeCloud({
    submitOrders: async attempt => { calls.push(attempt); return { status: 'unknown', lines: [], message: 'Lost.' }; },
    reconcileOrders: async attempt => { reads.push(attempt); return answer === 'unknown' ? null : sent(attempt.orders); },
  });
  const listener = createListener({ store: w.store, cloud, classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start(); w.store.createEntry(note(w.store, { body: ticket() })); await listener.tick();
    assert.equal(calls.length, 1); assert.equal(w.store.all('attempt')[0].status, 'unknown');
    w.store.createEntry(note(w.store, { body: ticket({ id: 'second-ticket' }) })); await listener.tick();
    assert.equal(calls.length, 1, 'An unknown delivery is never retried through a POST');
    assert.equal(reads.length, 1);
    assert.equal(reads[0].idempotencyKey, calls[0].idempotencyKey); assert.deepEqual(reads[0].orders, calls[0].orders);
    enable(w.store, { executionEnabled: false }); answer = 'submitted'; await listener.tick();
    assert.equal(calls.length, 1, 'Off permits readback but never dispatch');
    assert.equal(reads.length, 2);
    assert.equal(w.store.all('attempt')[0].status, 'submitted');
  } finally { listener.stop(); await w.close(); }
});

test('an unknown result from another account or connection is held without readback or dispatch', async () => {
  for (const change of ['account', 'connection']) {
    const w = await workspace(); let calls = 0, reads = 0, clientId = 'fixture-client';
    const cloud = fakeCloud({
      status: async () => ({ connected: true, clientId, connectionId: '00000000-0000-4000-8000-000000000005', scopes: ['mcp:read', 'mcp:write'] }),
      submitOrders: async () => { calls++; return { status: 'unknown', lines: [], message: 'Lost.' }; },
      reconcileOrders: async () => { reads++; return null; },
    });
    const listener = createListener({ store: w.store, cloud, classify: noModel, clock: () => now });
    try {
      enable(w.store); listener.start(); w.store.createEntry(note(w.store, { body: ticket() })); await listener.tick();
      if (change === 'account') enable(w.store, { accountId: '00000000-0000-4000-8000-000000000006' }); else clientId = 'different-device';
      w.store.createEntry(note(w.store, { body: ticket({ id: 'after-change' }) })); await listener.tick();
      assert.equal(calls, 1); assert.equal(reads, 0); assert.match(listener.status().lastError, /earlier account or connection/);
    } finally { listener.stop(); await w.close(); }
  }
});

test('retired pending and unknown attempts hold new tickets without invoking any legacy or order POST', async () => {
  for (const status of ['pending', 'unknown']) {
    const w = await workspace(); let calls = 0;
    const forbidden = async () => { calls++; throw new Error('A retired request must never be dispatched or automatically reconciled.'); };
    const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: forbidden, reconcileOrders: forbidden, runApprovedSignal: forbidden, reconcileRunByKey: forbidden }), classify: noModel, clock: () => now });
    try {
      enable(w.store, { notebookIds: [w.store.notebooks()[0].id] }); listener.start();
      const original = { id: 'listener-retired-key', status, body: { prompt: 'Frozen retired request.' }, atUtc: new Date(now).toISOString() };
      w.store.put('attempt', original.id, original);
      const entry = w.store.createEntry(note(w.store, { body: ticket() })); await listener.tick();
      assert.equal(calls, 0); assert.match(listener.status().lastError, /earlier listener submission.*never be resent/);
      assert.deepEqual(w.store.get('attempt', original.id), original);
      assert.equal(w.store.get('checkpoint', `local:${entry.id}`), null, 'The new ticket remains held for a later check.');
      w.store.put('attempt', original.id, { ...original, kind: 'legacy', status: 'resolved' });
      await listener.tick(); assert.equal(calls, 1, 'Owner resolution releases the hold for a new independent ticket.');
    } finally { await listener.stop(); await w.close(); }
  }
});

test('the immediate confirmation guard observes local opt-out and connection changes', async () => {
  for (const change of ['off', 'account', 'connection']) {
    const w = await workspace(); let confirmed = false, connectionId = 'original-connection';
    const cloud = fakeCloud({
      status: async () => ({ connected: true, clientId: 'fixture-client', connectionId, scopes: ['mcp:read', 'mcp:write'] }),
      submitOrders: async (_attempt, { canDispatch }) => {
        if (change === 'off') enable(w.store, { executionEnabled: false });
        if (change === 'account') enable(w.store, { accountId: '00000000-0000-4000-8000-000000000006' });
        if (change === 'connection') connectionId = 'new-connection';
        confirmed = await canDispatch();
        return { status: 'blocked', lines: [], message: 'Stopped before confirmation.' };
      },
    });
    const listener = createListener({ store: w.store, cloud, classify: noModel, clock: () => now });
    try {
      enable(w.store); listener.start(); w.store.createEntry(note(w.store, { body: ticket() })); await listener.tick();
      assert.equal(confirmed, false); assert.equal(w.store.all('attempt')[0].status, 'blocked');
    } finally { listener.stop(); await w.close(); }
  }
});

test('reviewed tickets with null signals remain non-executing', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async () => { calls++; } }), classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start();
    w.store.createEntry(note(w.store, { status: 'reviewed', signal: null, body: ticket() }));
    await listener.tick(); assert.equal(calls, 0); assert.equal(w.store.all('attempt').length, 0);
  } finally { listener.stop(); await w.close(); }
});

test('settings changes during model classification abort and do not checkpoint the old classification', async () => {
  const w = await workspace(); let release;
  const classify = () => new Promise(resolve => { release = resolve; });
  const listener = createListener({ store: w.store, cloud: fakeCloud(), classify, clock: () => now });
  try {
    enable(w.store); listener.start(); const entry = w.store.createEntry(note(w.store));
    const pending = listener.tick(); while (!release) await new Promise(resolve => setImmediate(resolve));
    enable(w.store, { section: 'Different heading' }); listener.refresh(); release(await candidate()); await pending;
    assert.equal(w.store.get('checkpoint', `local:${entry.id}`), null);
  } finally { listener.stop(); await w.close(); }
});
test('first cloud sync baselines imported notes; a changed old note is discovered by the next full scan', async () => {
  const w = await workspace(); let revision = 1, classifications = 0;
  const cloudEntry = { ...note(w.store), id: '00000000-0000-4000-8000-000000000004', notebookId, version: 1, createdAtUtc: new Date(now - 86400000).toISOString(), updatedAtUtc: new Date(now).toISOString(), signal: null };
  const listener = createListener({ store: w.store, cloud: fakeCloud({ readJournal: async () => ({ notebooks: [{ id: notebookId, name: 'Cloud', version: 1 }], entries: [{ ...cloudEntry, version: revision }], complete: true }) }), classify: async () => { classifications++; return { decision: 'review', reason: 'Research.' }; }, clock: () => now });
  try { enable(w.store, { source: 'cloud', executionEnabled: false, notebookIds: [] }); listener.start(); await listener.tick(); assert.equal(classifications, 0); revision = 2; await listener.tick(); assert.equal(classifications, 1); await listener.tick(); assert.equal(classifications, 1); }
  finally { listener.stop(); await w.close(); }
});

test('an interrupted cloud check discards its late snapshot before importing or baselining notes', async () => {
  const w = await workspace(); let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const cloudEntry = { ...note(w.store), id: '00000000-0000-4000-8000-000000000004', notebookId, version: 1, createdAtUtc: new Date(now).toISOString(), updatedAtUtc: new Date(now).toISOString(), signal: null };
  const listener = createListener({ store: w.store, cloud: fakeCloud({ readJournal: async () => {
    started(); await delayed;
    return { notebooks: [{ id: notebookId, name: 'Old connection', version: 1 }], entries: [cloudEntry], complete: true };
  } }), classify: candidate, clock: () => now });
  try {
    enable(w.store, { source: 'cloud' }); listener.start(); const checking = listener.tick(); await ready;
    enable(w.store, { enabled: false, executionEnabled: false }); listener.refresh();
    release(); await checking;
    assert.equal(w.store.entries().length, 0);
    assert.equal(w.store.notebooks().some(row => row.origin === 'cloud'), false);
    assert.equal(w.store.get('sync', 'baseline'), null);
    assert.equal(w.store.all('attempt').length, 0);
  } finally { release(); listener.stop(); await w.close(); }
});

test('stop drains an active scheduled classification and its old timer cannot restart the listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await workspace(), started = deferred(), finish = deferred(); let classifications = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud(), classify: async () => { classifications++; started.resolve(); return finish.promise; }, clock: () => now });
  try {
    enable(w.store, { intervalSeconds: 15, executionEnabled: false }); listener.start();
    const entry = w.store.createEntry(note(w.store));
    t.mock.timers.tick(15000); await started.promise;
    let drained = false; const stopping = listener.stop().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    finish.resolve({ decision: 'review', reason: 'Synthetic research.' }); await stopping;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(listener.status().busy, false); assert.equal(listener.status().running, false);
    assert.equal(w.store.get('checkpoint', `local:${entry.id}`), null);
    w.store.createEntry(note(w.store)); listener.refresh(); await listener.tick();
    t.mock.timers.tick(60000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(classifications, 1); assert.equal(listener.status().running, false);
  } finally { finish.resolve({ decision: 'review', reason: 'Cleanup.' }); await listener.stop(); await w.close(); }
});

test('stop preserves the result or uncertainty of an already sent ticket before draining', async () => {
  for (const outcome of ['submitted', 'unknown', 'failed-response']) {
    const w = await workspace(), started = deferred(), finish = deferred(); let calls = 0;
    const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async ({ orders }) => { calls++; started.resolve(); await finish.promise; if (outcome === 'failed-response') throw new Error('Synthetic lost response.'); return outcome === 'submitted' ? sent(orders) : { status: 'unknown', lines: [], message: 'Lost.' }; } }), classify: noModel, clock: () => now });
    try {
      enable(w.store); listener.start(); w.store.createEntry(note(w.store, { body: ticket() }));
      w.store.createEntry(note(w.store, { body: ticket({ id: 'second-ticket' }) }));
      const checking = listener.tick(); await started.promise;
      let drained = false; const stopping = listener.stop().then(() => { drained = true; });
      await Promise.resolve(); assert.equal(drained, false);
      assert.equal(w.store.all('attempt')[0].status, 'pending');
      finish.resolve(); await stopping; await checking;
      assert.equal(calls, 1); const attempts = w.store.all('attempt'); assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, outcome === 'submitted' ? 'submitted' : 'unknown');
    } finally { finish.resolve(); await listener.stop(); await w.close(); }
  }
});
test('an old prompt-policy attempt is never replayed as an order list', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async () => { calls++; } }), classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start(); w.store.put('attempt', 'legacy', { id: 'legacy', status: 'unknown', idempotencyKey: 'legacy-prompt-key', body: { schemaVersion: 'product.prompt_trading_run_request.v1' } });
    await listener.tick(); assert.equal(calls, 0); assert.match(listener.status().lastError, /earlier listener submission.*never be resent/);
  } finally { listener.stop(); await w.close(); }
});

test('auto-trade only acts on picked notebooks and stops at the daily ticket cap', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async ({ orders }) => { calls++; return sent(orders); } }), classify: noModel, clock: () => now });
  try {
    enable(w.store, { notebookIds: [] }); listener.start();
    w.store.createEntry(note(w.store, { body: ticket({ id: 'unpicked' }) })); await listener.tick();
    assert.equal(calls, 0); assert.match(w.store.all('activity').map(row => row.reason).join(' '), /Pick the notebooks/);
    enable(w.store, { maxTicketsPerDay: 1 });
    w.store.createEntry(note(w.store, { body: ticket({ id: 'first-today' }) })); await listener.tick();
    w.store.createEntry(note(w.store, { body: ticket({ id: 'second-today' }) })); await listener.tick();
    assert.equal(calls, 1); assert.match(w.store.all('activity').map(row => row.reason).join(' '), /Daily limit reached: 1 ticket/);
  } finally { listener.stop(); await w.close(); }
});

test('public progress is visible during model work and retains its published decision without internal reasoning', async () => {
  const w = await workspace(), started = deferred(), finish = deferred();
  const listener = createListener({ store: w.store, cloud: fakeCloud(), classify: async () => { started.resolve(); return finish.promise; }, clock: () => now });
  try {
    enable(w.store); listener.start(); const entry = w.store.createEntry(note(w.store));
    const tick = listener.tick(); await started.promise;
    const during = listener.status();
    assert.equal(during.busy, true); assert.equal(during.processing.stage, 'model'); assert.equal(during.processing.entryId, entry.id);
    assert.equal(during.processing.running, true); assert.equal(w.store.all('activity')[0].status, 'processing');
    assert.deepEqual(during.events.slice(-3).map(row => row.stage), ['queued', 'read', 'model']);
    during.events.length = 0; assert.ok(listener.status().events.length > 0, 'Status snapshots cannot mutate runtime progress.');
    finish.resolve({ decision: 'review', reason: 'An explicit action ticket is missing.' }); await tick;
    const after = listener.status();
    assert.equal(after.processing.stage, 'idle'); assert.equal(after.processing.running, false);
    assert.equal(after.lastModelOutput.reason, 'An explicit action ticket is missing.');
    assert.ok(after.events.some(row => row.stage === 'decision' && row.message === after.lastModelOutput.reason));
    assert.ok(after.events.some(row => row.stage === 'result' && row.message.includes('flusso-close')));
    assert.equal(after.events.some(row => 'thinking' in row || 'reasoning' in row), false);
    for (let i = 0; i < 30; i++) await listener.tick();
    assert.equal(listener.status().events.length, 100, 'Runtime transcript stays bounded.');
  } finally { finish.resolve({ decision: 'ignore', reason: 'Cleanup.' }); await listener.stop(); await w.close(); }
});

test('an explicit close ticket reaches the existing reduce-only path once with retained public receipts', async () => {
  const w = await workspace(), calls = [];
  const positionIds = ['d93d1eec-2a5e-f058-b846-d12fd573ae1d', 'eff0bb01-73ff-8b54-9b6f-7b491cf9b280'];
  const body = '```flusso-close\n' + JSON.stringify({ id: 'close-exact-owned-positions', positionIds }) + '\n```';
  const listener = createListener({ store: w.store, cloud: fakeCloud({ closePositions: async (attempt, { canDispatch }) => {
    assert.equal(await canDispatch(), true); calls.push(attempt);
    return { status: 'submitted', lines: positionIds.map(positionId => ({ positionId, status: 'submitted', message: 'Reduce-only close accepted.' })) };
  }, submitOrders: async () => { throw new Error('Close must not use opening orders.'); } }), classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start(); const entry = w.store.createEntry(note(w.store, { body })); await listener.tick();
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].positionIds, positionIds); assert.equal(calls[0].kind, 'close');
    assert.equal(w.store.entry(entry.id).status, 'reviewed'); assert.match(w.store.entry(entry.id).body, /close d93d1eec.*: sent/);
    w.store.createEntry(note(w.store, { body })); await listener.tick(); assert.equal(calls.length, 1);
    assert.ok(listener.status().events.some(row => row.stage === 'submit'));
    assert.ok(listener.status().events.some(row => row.stage === 'result' && row.status === 'submitted'));
  } finally { await listener.stop(); await w.close(); }
});

test('an unknown close holds new instructions across restart without resending until the retained claim is resolved', async () => {
  const w = await workspace(); let closes = 0, orders = 0;
  const body = '```flusso-close\n' + JSON.stringify({ id: 'close-uncertain-original', positionIds: ['d93d1eec-2a5e-f058-b846-d12fd573ae1d'] }) + '\n```';
  const cloud = fakeCloud({ closePositions: async () => { closes++; return { status: 'unknown', lines: [], message: 'Synthetic lost close receipt.' }; }, submitOrders: async ({ orders: lines }) => { orders++; return sent(lines); } });
  let listener = createListener({ store: w.store, cloud, classify: noModel, clock: () => now });
  try {
    enable(w.store); listener.start(); w.store.createEntry(note(w.store, { body })); await listener.tick();
    const attempt = w.store.all('attempt')[0]; assert.equal(attempt.kind, 'close'); assert.equal(attempt.status, 'unknown');
    w.store.createEntry(note(w.store, { body: ticket({ id: 'opening-after-unknown-close' }) }));
    await listener.stop(); listener = createListener({ store: w.store, cloud, classify: noModel, clock: () => now }); listener.start(); await listener.tick();
    assert.equal(closes, 1); assert.equal(orders, 0); assert.match(listener.status().lastError, /position close.*unconfirmed/);
    assert.ok(w.store.all('activity').some(row => row.status === 'waiting'));
    // Simulate the owner's explicit resolution after canonical reconciliation.
    w.store.put('attempt', attempt.id, { ...w.store.get('attempt', attempt.id), status: 'resolved' });
    await listener.tick(); assert.equal(closes, 1); assert.equal(orders, 1);
    w.store.createEntry(note(w.store, { body })); await listener.tick(); assert.equal(closes, 1, 'Resolution never releases the original durable close identity.');
  } finally { await listener.stop(); await w.close(); }
});


test('manual Check now re-reviews the newest selected research note, streams it, and never replays a decided ticket', async () => {
  const w = await workspace(), started = deferred(), finish = deferred(); let reviews = 0, sends = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ submitOrders: async attempt => { sends++; return sent(attempt.orders); } }),
    classify: async ({ entry, onOutput }) => { reviews++; onOutput('fresh model response'); started.resolve(entry); return finish.promise; }, clock: () => now });
  const updates = []; const unsubscribe = listener.subscribe(state => updates.push(state));
  try {
    enable(w.store);
    w.store.createEntry(note(w.store, { title: 'Closed note stays closed', status: 'closed' }));
    const research = w.store.createEntry(note(w.store, { title: 'Existing reviewed research', status: 'reviewed' }));
    listener.start(); await listener.tick(); assert.equal(reviews, 0);
    w.store.createEntry(note(w.store, { body: ticket({ id: 'stream-safety' }) })); await listener.tick(); assert.equal(sends, 1);
    const tick = listener.tick({ manual: true }); assert.equal((await started.promise).id, research.id);
    assert.equal(listener.status().modelOutput.text, 'fresh model response');
    assert.equal(listener.status().modelOutput.status, 'streaming');
    assert.equal(listener.status().lastModelOutput, null, 'Partial text is not a decision.');
    assert.ok(updates.some(state => state.modelOutput?.text === 'fresh model response' && state.busy));
    finish.resolve({ decision: 'review', reason: 'This is the actual model decision.' }); await tick;
    assert.equal(listener.status().modelOutput.status, 'complete'); assert.equal(sends, 1);
    await listener.tick(); assert.equal(reviews, 1, 'Scheduled checks still honor checkpoints.');
    assert.equal(w.store.entry(research.id).status, 'reviewed');
    const count = updates.length; unsubscribe(); await listener.tick(); assert.equal(updates.length, count);
  } finally { finish.resolve({ decision: 'ignore', reason: 'Cleanup.' }); unsubscribe(); await listener.stop(); await w.close(); }
});

test('a failed streamed answer retains its partial text as failed and leaves the note retryable', async () => {
  const w = await workspace();
  const listener = createListener({ store: w.store, cloud: fakeCloud(), classify: async ({ onOutput }) => { onOutput('unfinished response'); throw new Error('The local model stopped.'); }, clock: () => now });
  try {
    enable(w.store); listener.start(); const entry = w.store.createEntry(note(w.store)); await listener.tick();
    assert.equal(listener.status().modelOutput.status, 'failed'); assert.equal(listener.status().modelOutput.text, 'unfinished response');
    assert.equal(listener.status().lastModelOutput, null); assert.equal(w.store.get('checkpoint', `local:${entry.id}`), null);
  } finally { await listener.stop(); await w.close(); }
});
