import test from 'node:test';
import assert from 'node:assert/strict';
import { createListener } from '../src/listener.mjs';
import { buildRunRequest } from '../src/cloud.mjs';
import { workspace, note, signal, fakeCloud, enable, now, notebookId } from './helpers.mjs';

const candidate = async () => ({ decision: 'candidate', reason: 'Fixture match.' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
test('turning on baselines old notes; a new typed signal submits at most once across edits and copies', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ runApprovedSignal: async () => { calls++; return { status: 'submitted' }; } }), buildRunRequest, classify: candidate, clock: () => now });
  try {
    w.store.createEntry(note(w.store, { signal: signal({ sourceRecordId: 'old' }) })); enable(w.store); listener.start(); await listener.tick(); assert.equal(calls, 0);
    const entry = w.store.createEntry(note(w.store, { signal: signal() })); await listener.tick(); assert.equal(calls, 1);
    w.store.updateEntry(entry.id, { ...note(w.store), body: 'Edited prose', version: entry.version }); await listener.tick(); assert.equal(calls, 1);
    w.store.createEntry(note(w.store, { signal: signal() })); await listener.tick(); assert.equal(calls, 1);
  } finally { listener.stop(); await w.close(); }
});
test('prose and stale structured notes are research only even if the model says candidate', async () => {
  const w = await workspace(); let calls = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ runApprovedSignal: async () => { calls++; } }), buildRunRequest, classify: candidate, clock: () => now });
  try { enable(w.store); listener.start(); w.store.createEntry(note(w.store)); w.store.createEntry(note(w.store, { signal: signal({ quality: 'stale' }) })); await listener.tick(); assert.equal(calls, 0); assert.equal(w.store.all('activity').every(row => row.status === 'review'), true); }
  finally { listener.stop(); await w.close(); }
});
test('unknown POST outcome pauses subsequent signals and uses original retry identity for readback', async () => {
  const w = await workspace(); let calls = 0, readKey;
  const cloud = fakeCloud({ runApprovedSignal: async () => { calls++; return { status: 'unknown' }; }, reconcileRunByKey: async ({ idempotencyKey }) => { readKey = idempotencyKey; return { status: 'unknown' }; } });
  const listener = createListener({ store: w.store, cloud, buildRunRequest, classify: candidate, clock: () => now });
  try { enable(w.store); listener.start(); w.store.createEntry(note(w.store, { signal: signal() })); await listener.tick(); assert.equal(calls, 1); const attempt = w.store.all('attempt')[0]; w.store.createEntry(note(w.store, { signal: signal({ sourceRecordId: 'next' }) })); await listener.tick(); assert.equal(calls, 1); assert.equal(readKey, attempt.idempotencyKey); assert.equal(w.store.all('attempt')[0].status, 'unknown'); }
  finally { listener.stop(); await w.close(); }
});
test('settings changes during model classification abort admission and do not checkpoint the old classification', async () => {
  const w = await workspace(); let release, calls = 0;
  const classify = () => new Promise(resolve => { release = resolve; });
  const listener = createListener({ store: w.store, cloud: fakeCloud({ runApprovedSignal: async () => { calls++; } }), buildRunRequest, classify, clock: () => now });
  try {
    enable(w.store); listener.start(); const entry = w.store.createEntry(note(w.store, { signal: signal() }));
    const pending = listener.tick(); while (!release) await new Promise(resolve => setImmediate(resolve));
    enable(w.store, { section: 'Different heading' }); listener.refresh(); release(await candidate()); await pending;
    assert.equal(calls, 0); assert.equal(w.store.get('checkpoint', `local:${entry.id}`), null);
  } finally { listener.stop(); await w.close(); }
});
test('first cloud sync baselines imported notes; a changed old note is discovered by the next full scan', async () => {
  const w = await workspace(); let revision = 1, classifications = 0;
  const cloudEntry = { ...note(w.store), id: '00000000-0000-4000-8000-000000000004', notebookId, version: 1, createdAtUtc: new Date(now - 86400000).toISOString(), updatedAtUtc: new Date(now).toISOString(), signal: null };
  const listener = createListener({ store: w.store, cloud: fakeCloud({ readJournal: async () => ({ notebooks: [{ id: notebookId, name: 'Cloud', version: 1 }], entries: [{ ...cloudEntry, version: revision }], complete: true }) }), buildRunRequest, classify: async () => { classifications++; return { decision: 'review', reason: 'Research.' }; }, clock: () => now });
  try { enable(w.store, { source: 'cloud', executionEnabled: false }); listener.start(); await listener.tick(); assert.equal(classifications, 0); revision = 2; await listener.tick(); assert.equal(classifications, 1); await listener.tick(); assert.equal(classifications, 1); }
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
  } }), buildRunRequest, classify: candidate, clock: () => now });
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
  const listener = createListener({ store: w.store, cloud: fakeCloud(), buildRunRequest, classify: async () => { classifications++; started.resolve(); return finish.promise; }, clock: () => now });
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

test('stop preserves the receipt or uncertainty of an already dispatched run before draining', async () => {
  for (const outcome of ['submitted', 'unknown', 'failed-response']) {
    const w = await workspace(), started = deferred(), finish = deferred(); let calls = 0;
    const listener = createListener({ store: w.store, cloud: fakeCloud({ runApprovedSignal: async () => { calls++; started.resolve(); await finish.promise; if (outcome === 'failed-response') throw new Error('Synthetic lost response.'); return { status: outcome }; } }), buildRunRequest, classify: candidate, clock: () => now });
    try {
      enable(w.store); listener.start(); w.store.createEntry(note(w.store, { signal: signal() }));
      w.store.createEntry(note(w.store, { signal: signal({ sourceRecordId: 'second-signal' }) }));
      const checking = listener.tick(); await started.promise;
      let drained = false; const stopping = listener.stop().then(() => { drained = true; });
      await Promise.resolve(); assert.equal(drained, false);
      assert.equal(w.store.all('attempt')[0].status, 'pending');
      finish.resolve(); await stopping; await checking;
      assert.equal(calls, 1); const attempts = w.store.all('attempt'); assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, outcome === 'submitted' ? 'answered' : 'unknown');
      if (outcome !== 'failed-response') assert.equal(attempts[0].receipt.status, outcome);
    } finally { finish.resolve(); await listener.stop(); await w.close(); }
  }
});

test('stop drains the current canonical readback and does not begin another reconciliation', async () => {
  const w = await workspace(), started = deferred(), finish = deferred(); let reads = 0;
  const listener = createListener({ store: w.store, cloud: fakeCloud({ reconcileRunByKey: async () => { reads++; started.resolve(); await finish.promise; return { status: 'submitted' }; } }), buildRunRequest, classify: candidate, clock: () => now });
  try {
    enable(w.store); listener.start();
    w.store.put('attempt', 'original-a', { id: 'original-a', status: 'unknown', idempotencyKey: 'original-key-a' });
    w.store.put('attempt', 'original-b', { id: 'original-b', status: 'unknown', idempotencyKey: 'original-key-b' });
    const checking = listener.tick(); await started.promise;
    let drained = false; const stopping = listener.stop().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    finish.resolve(); await stopping; await checking;
    assert.equal(reads, 1); assert.equal(w.store.get('attempt', 'original-a').status, 'reconciled');
    assert.equal(w.store.get('attempt', 'original-b').status, 'unknown');
  } finally { finish.resolve(); await listener.stop(); await w.close(); }
});
