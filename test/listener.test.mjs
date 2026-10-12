import test from 'node:test';
import assert from 'node:assert/strict';
import { createListener } from '../src/listener.mjs';
import { buildRunRequest } from '../src/cloud.mjs';
import { workspace, note, signal, fakeCloud, enable, now, notebookId } from './helpers.mjs';

const candidate = async () => ({ decision: 'candidate', reason: 'Fixture match.' });
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
