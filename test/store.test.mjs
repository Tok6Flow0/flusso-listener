import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.mjs';
import { journalInput, signalSnapshot, settingsInput } from '../src/schema.mjs';
import { workspace, note, signal, memoryVault } from './helpers.mjs';

test('Journal persists ciphertext, retries exact content, and rejects conflicting retry keys', async () => {
  const w = await workspace(); try {
    const input = note(w.store, { body: 'Private research phrase hidden from database inspection.', signal: signal() });
    const entry = w.store.createEntry(input, 'stable-original-key');
    assert.deepEqual(w.store.createEntry(input, 'stable-original-key'), entry);
    assert.equal(w.store.entries().length, 1);
    assert.throws(() => w.store.createEntry({ ...input, body: 'changed' }, 'stable-original-key'), /different content/);
    const bytes = await readFile(join(w.directory, 'journal.db'));
    assert.equal(bytes.includes(Buffer.from(input.body)), false);
    assert.equal(bytes.includes(Buffer.from(input.signal.legs[0].asset.instrumentId)), false);
    assert.equal(bytes.includes(Buffer.from('journal-encryption-key')), false);
  } finally { await w.close(); }
});
test('optimistic edits preserve an omitted structured snapshot and clear only explicit null', async () => {
  const w = await workspace(); try {
    const input = note(w.store, { signal: signal() }), first = w.store.createEntry(input);
    const second = w.store.updateEntry(first.id, { ...note(w.store), version: first.version });
    assert.deepEqual(second.signal, first.signal);
    assert.throws(() => w.store.updateEntry(first.id, { ...input, version: first.version }), /latest version/);
    const third = w.store.updateEntry(first.id, { ...note(w.store), signal: null, version: second.version });
    assert.equal(third.signal, null);
  } finally { await w.close(); }
});
test('local edit and its encrypted retry reply commit atomically; internal edits do not add retry records', async () => {
  const w = await workspace(); let observer;
  try {
    const original = w.store.createEntry(note(w.store)), retriesBefore = w.store.all('retry').length;
    const input = { ...note(w.store), body: 'Private edited research reply.', version: original.version };
    observer = new DatabaseSync(join(w.directory, 'journal.db'));
    observer.exec("CREATE TRIGGER refuse_edit_retry BEFORE INSERT ON records WHEN NEW.kind='retry' AND NEW.id='atomic-edit-key' BEGIN SELECT RAISE(ABORT,'Synthetic retry write refusal'); END;");
    assert.throws(() => w.store.updateEntry(original.id, input, 'atomic-edit-key'), /Synthetic retry write refusal/);
    assert.deepEqual(w.store.entry(original.id), original); assert.equal(w.store.get('retry', 'atomic-edit-key'), null);
    observer.exec('DROP TRIGGER refuse_edit_retry');
    const saved = w.store.updateEntry(original.id, input, 'atomic-edit-key');
    assert.deepEqual(w.store.updateEntry(original.id, input, 'atomic-edit-key'), saved);
    assert.equal(w.store.all('retry').length, retriesBefore + 1);
    const later = w.store.updateEntry(original.id, { ...input, body: 'Internal result annotation.', version: saved.version });
    assert.equal(w.store.all('retry').length, retriesBefore + 1, 'Internal optimistic writes keep their existing behavior.');
    assert.deepEqual(w.store.updateEntry(original.id, input, 'atomic-edit-key'), saved);
    assert.deepEqual(w.store.entry(original.id), later);
    const bytes = await readFile(join(w.directory, 'journal.db'));
    assert.equal(bytes.includes(Buffer.from(input.body)), false, 'The retained reply uses existing record encryption.');
    assert.equal(w.store.all('attempt').length, 0);
  } finally { observer?.close(); await w.close(); }
});
test('missing OS encryption key never replaces or destroys an existing Journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-vault-test-')), vault = memoryVault();
  try {
    const first = await openStore({ directory, vault }); first.createEntry(note(first)); first.close();
    const before = await readFile(join(directory, 'journal.db')); await vault.delete('journal-encryption-key');
    await assert.rejects(openStore({ directory, vault }), /original keychain/);
    assert.deepEqual(await readFile(join(directory, 'journal.db')), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('linked data directories are refused', async () => {
  if (process.platform === 'win32') return;
  const parent = await mkdtemp(join(tmpdir(), 'flusso-link-test-'));
  try { await symlink(parent, join(parent, 'linked')); await assert.rejects(openStore({ directory: join(parent, 'linked'), encryptionKey: randomBytes(32) }), /real private directory/); }
  finally { await rm(parent, { recursive: true, force: true }); }
});
test('source signal claim is durable and independent of note revision', async () => {
  const w = await workspace(); try {
    assert.equal(w.store.claimAttempt({ id: 'first', signalIdentity: 'same-source', version: 1 }), true);
    assert.equal(w.store.claimAttempt({ id: 'second', signalIdentity: 'same-source', version: 2 }), false);
    assert.equal(w.store.all('attempt').length, 1);
  } finally { await w.close(); }
});

test('completed research and removal of its exact progress are atomic even if SQLite refuses the delete', async () => {
  const w = await workspace(); let observer;
  try {
    const progress = { id: 'research-progress', kind: 'research_check', entryId: 'research-entry', origin: 'local', version: 1, checkId: 'new-check', status: 'processing' };
    const previous = { ...progress, id: 'accepted-research', kind: 'research', checkId: 'previous-check', status: 'observed', decision: 'review', reason: 'Previous actual reason.' };
    const accepted = { ...previous, checkId: progress.checkId, reason: 'New actual reason.', completedAtUtc: '2026-10-23T12:00:00Z' };
    w.store.put('activity', previous.id, previous); w.store.put('activity', progress.id, progress);
    assert.throws(() => w.store.completeResearchResult({ ...accepted, checkId: 'different-check' }, progress.id), /Research progress changed/);
    observer = new DatabaseSync(join(w.directory, 'journal.db'));
    observer.exec("CREATE TRIGGER refuse_research_delete BEFORE DELETE ON records WHEN OLD.kind='activity' AND OLD.id='research-progress' BEGIN SELECT RAISE(ABORT,'Synthetic progress delete refusal'); END;");
    assert.throws(() => w.store.completeResearchResult(accepted, progress.id), /Synthetic progress delete refusal/);
    assert.deepEqual(w.store.get('activity', previous.id), previous, 'The accepted write rolls back with the failed cleanup.');
    assert.deepEqual(w.store.get('activity', progress.id), progress);
    observer.exec('DROP TRIGGER refuse_research_delete');
    assert.deepEqual(w.store.completeResearchResult(accepted, progress.id), accepted);
    assert.deepEqual(w.store.get('activity', accepted.id), accepted); assert.equal(w.store.get('activity', progress.id), null);
    assert.equal(w.store.all('activity').length, 1); assert.equal(w.store.all('attempt').length, 0);
  } finally { observer?.close(); await w.close(); }
});
test('typed Journal schema rejects unknown instructions, invalid units and missing source clocks', () => {
  assert.throws(() => journalInput({ notebookId: 'bad', title: 'x', body: '' }), /notebook/);
  assert.throws(() => signalSnapshot({ ...signal(), execute: true }), /Unsupported signal field/);
  const wrong = signal(); wrong.legs[0].quantityUnit = 'dollars'; assert.throws(() => signalSnapshot(wrong), /quantity unit/);
  const missing = signal(); delete missing.legs[0].asset.observedAtUtc; assert.throws(() => signalSnapshot(missing), /asset clock/);
  const bad = signal(); bad.legs[0].quantity = Infinity; assert.throws(() => signalSnapshot(bad), /quantity/);
  const settings = { version: 1, enabled: false, executionEnabled: false, source: 'local', notebookIds: [], section: '', instructions: 'x'.repeat(1001), intervalSeconds: 60, accountId: null, risk: { maxSlippagePct: null, maxOrderUsd: null, maxTicketUsd: null, maxLeverage: null, minVolume24hUsd: null, together: true }, maxSignalAgeSeconds: 900 };
  assert.throws(() => settingsInput(settings), /custom instructions/);
  assert.throws(() => settingsInput({ ...settings, instructions: '', authorizationId: null }), /Unsupported request field/);
  assert.throws(() => settingsInput({ ...settings, instructions: '', executionEnabled: true, risk: { ...settings.risk, maxOrderUsd: 900, maxTicketUsd: 1800, maxLeverage: 10 } }), /Pick the notebooks/);
  assert.throws(() => settingsInput({ ...settings, instructions: '', maxTicketsPerDay: 0 }), /tickets per day/);
  assert.equal(settingsInput({ ...settings, instructions: '' }).maxTicketsPerDay, 24);
  assert.throws(() => settingsInput({ ...settings, instructions: '', risk: { ...settings.risk, maxOrderUsd: -1 } }), /maximum order size/);
});
test('a preview.1 policy setting is retired on open and execution restarts off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-migrate-test-')), key = randomBytes(32);
  try {
    const first = await openStore({ directory, encryptionKey: Buffer.from(key) });
    first.put('settings', 'main', { ...first.settings(), executionEnabled: true, authorizationId: 'old', policy: { instrumentId: 'coinbase:spot:BTC-USD' }, maxSignalAgeSeconds: 120, risk: undefined });
    const original = { id: 'listener-retired-key', signalIdentity: 'retired-signal', idempotencyKey: 'listener-retired-key', accountId: 'old-account', authorizationId: 'old', body: { prompt: 'Original frozen policy request.' }, status: 'unknown', atUtc: '2026-10-01T00:00:00Z' };
    first.claimAttempt(original);
    first.put('attempt', 'listener-retired-pending', { ...original, id: 'listener-retired-pending', idempotencyKey: 'listener-retired-pending', status: 'pending' });
    first.put('attempt', 'listener-retired-answered', { ...original, id: 'listener-retired-answered', status: 'answered' });
    first.close();
    const second = await openStore({ directory, encryptionKey: Buffer.from(key) });
    const settings = second.settings();
    assert.equal('policy' in settings, false); assert.equal('authorizationId' in settings, false);
    assert.equal(settings.executionEnabled, false); assert.equal(settings.maxSignalAgeSeconds, 21600); assert.equal(settings.writeBack, true);
    assert.deepEqual(settings.risk, { maxSlippagePct: null, maxOrderUsd: null, maxTicketUsd: null, maxLeverage: null, minVolume24hUsd: null, together: true });
    assert.deepEqual(second.get('attempt', original.id), { ...original, kind: 'legacy' });
    assert.equal(second.get('attempt', 'listener-retired-pending').kind, 'legacy');
    assert.equal(second.get('attempt', 'listener-retired-answered').kind, undefined);
    assert.equal(second.claimAttempt({ ...original, id: 'replacement' }), false, 'The original source claim stays durable.');
    const holds = second.all('activity').filter(row => row.kind === 'legacy');
    assert.equal(holds.length, 2); assert.equal(holds[0].status, 'unknown');
    assert.match(holds.find(row => row.attemptId === original.id).reason, /listener-retired-key.*never be resent/);
    second.close();
    const third = await openStore({ directory, encryptionKey: Buffer.from(key) });
    assert.equal(third.all('activity').filter(row => row.kind === 'legacy').length, 2, 'Reopening does not duplicate recovery holds.');
    assert.deepEqual(third.get('attempt', original.id).body, original.body);
    third.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('a saved 15-minute ticket window is raised to six hours once, and other choices are kept', async () => {
  for (const [saved, expected] of [[900, 21600], [3600, 3600]]) {
    const directory = await mkdtemp(join(tmpdir(), 'flusso-window-test-')), key = randomBytes(32);
    try {
      const first = await openStore({ directory, encryptionKey: Buffer.from(key) });
      const { settingsRevision: _revision, writeBack: _writeBack, ...older } = first.settings();
      first.put('settings', 'main', { ...older, maxSignalAgeSeconds: saved });
      first.close();
      const second = await openStore({ directory, encryptionKey: Buffer.from(key) });
      assert.equal(second.settings().maxSignalAgeSeconds, expected);
      assert.equal(second.settings().writeBack, true); assert.equal(second.settings().settingsRevision, 2);
      second.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});


test('notebook creation replays an encrypted original reply after close/reopen and binds the operation and name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-notebook-retry-')), vault = memoryVault(); let store;
  try {
    store = await openStore({ directory, vault });
    const name = 'Private exact notebook name', count = store.notebooks().length;
    const saved = store.createNotebook(name, 'stable-notebook-key');
    assert.deepEqual(store.createNotebook(name, 'stable-notebook-key'), saved); assert.equal(store.notebooks().length, count + 1);
    assert.throws(() => store.createNotebook('Different name', 'stable-notebook-key'), /different content/);
    assert.throws(() => store.createEntry(note(store), 'stable-notebook-key'), /different content/);
    const entry = store.createEntry(note(store), 'entry-only-key');
    assert.throws(() => store.createNotebook(name, 'entry-only-key'), /different content/);
    assert.throws(() => store.updateEntry(entry.id, { ...note(store), version: 1 }, 'stable-notebook-key'), /different content/);
    store.close(); store = await openStore({ directory, vault });
    assert.deepEqual(store.createNotebook(name, 'stable-notebook-key'), saved); assert.equal(store.notebooks().length, count + 1);
    const other = store.createNotebook(name, 'intentional-same-name'); assert.notEqual(other.id, saved.id);
    const retries = store.all('retry').length; store.createNotebook('Internal notebook'); assert.equal(store.all('retry').length, retries);
    const bytes = await readFile(join(directory, 'journal.db')); assert.equal(bytes.includes(Buffer.from(name)), false);
    assert.equal(store.all('attempt').length, 0);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('notebook row and original retry reply commit atomically', async () => {
  const w = await workspace(); let observer;
  try {
    const before = w.store.notebooks(); observer = new DatabaseSync(join(w.directory, 'journal.db'));
    observer.exec("CREATE TRIGGER refuse_notebook_retry BEFORE INSERT ON records WHEN NEW.kind='retry' AND NEW.id='notebook-atomic-key' BEGIN SELECT RAISE(ABORT,'Synthetic notebook retry refusal'); END;");
    assert.throws(() => w.store.createNotebook('Atomic notebook', 'notebook-atomic-key'), /Synthetic notebook retry refusal/);
    assert.deepEqual(w.store.notebooks(), before); assert.equal(w.store.get('retry', 'notebook-atomic-key'), null);
    observer.exec('DROP TRIGGER refuse_notebook_retry');
    const saved = w.store.createNotebook('Atomic notebook', 'notebook-atomic-key'); assert.deepEqual(w.store.createNotebook('Atomic notebook', 'notebook-atomic-key'), saved);
  } finally { observer?.close(); await w.close(); }
});
