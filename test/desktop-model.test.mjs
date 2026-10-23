import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopModel } from '../desktop/model.mjs';

test('trusted existing-model mode preserves pinned identity checks and forbids setup/download/copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-isolated-model-test-'));
  const existingModelPath = join(directory, 'wrong-weights.gguf');
  const originalFetch = globalThis.fetch; let networkCalls = 0, model;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Existing-model verification attempted network.'); };
  try {
    await writeFile(existingModelPath, 'wrong weights');
    model = createDesktopModel({ directory: join(directory, 'isolated'), runtimeDirectory: join(directory, 'absent-runtime'), existingModelPath });
    assert.equal((await model.initialize()).state, 'missing', 'Wrong pinned size must not reach the engine.');
    await assert.rejects(model.setup(), /cannot download or copy/);
    assert.equal(await readFile(existingModelPath, 'utf8'), 'wrong weights');
    assert.deepEqual(await readdir(join(directory, 'isolated', 'models')), []);
    assert.equal(networkCalls, 0);
    await assert.rejects(model.classify({ entry: { body: 'Synthetic research.' } }), error => { assert.match(error.message, /The research review could not start/); assert.doesNotMatch(error.message, /No execution/); return true; });
    assert.throws(() => createDesktopModel({ directory, runtimeDirectory: directory, existingModelPath: 'relative.gguf' }), /absolute existing model path/);
  } finally { await model?.stop(); globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('existing-model mode refuses symlinked weights instead of relaxing verification for a replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-linked-model-test-'));
  let model;
  try {
    const target = join(directory, 'weights.gguf'), existingModelPath = join(directory, 'linked.gguf');
    await writeFile(target, 'synthetic'); await symlink(target, existingModelPath);
    model = createDesktopModel({ directory: join(directory, 'isolated'), runtimeDirectory: directory, existingModelPath });
    assert.equal((await model.initialize()).state, 'error');
    assert.deepEqual(await readdir(join(directory, 'isolated', 'models')), []);
    assert.equal(await readFile(target, 'utf8'), 'synthetic');
  } finally { await model?.stop(); await rm(directory, { recursive: true, force: true }); }
});
