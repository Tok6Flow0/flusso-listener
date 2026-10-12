import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
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
test('typed Journal schema rejects unknown instructions, invalid units and missing source clocks', () => {
  assert.throws(() => journalInput({ notebookId: 'bad', title: 'x', body: '' }), /notebook/);
  assert.throws(() => signalSnapshot({ ...signal(), execute: true }), /Unsupported signal field/);
  const wrong = signal(); wrong.legs[0].quantityUnit = 'dollars'; assert.throws(() => signalSnapshot(wrong), /quantity unit/);
  const missing = signal(); delete missing.legs[0].asset.observedAtUtc; assert.throws(() => signalSnapshot(missing), /asset clock/);
  const bad = signal(); bad.legs[0].quantity = Infinity; assert.throws(() => signalSnapshot(bad), /quantity/);
  const settings = { version: 1, enabled: false, executionEnabled: false, source: 'local', notebookIds: [], section: '', instructions: 'x'.repeat(1001), intervalSeconds: 60, accountId: null, authorizationId: null };
  assert.throws(() => settingsInput(settings), /custom instructions/);
});
