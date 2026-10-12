import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifiedDownload, verifiedFile } from '../desktop/download.mjs';

const bytes = Buffer.from('Synthetic pinned model resource. No real model or credentials.');
const resource = { url: 'https://registry.ollama.ai/v2/library/synthetic/blobs/pinned', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-desktop-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, destination: join(directory, 'synthetic.gguf') };
}
function streamed(chunks) {
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }));
}
async function empty(directory) { assert.deepEqual(await readdir(directory), [], 'No model or partial download may remain.'); }

test('pinned desktop download installs verified bytes privately and reuses only a verified file', async t => {
  const { directory, destination } = await fixture(t); const progress = []; let calls = 0;
  const options = { ...resource, destination, onProgress: value => progress.push(value), fetchImpl: async (_url, request) => { calls++; assert.equal(request.redirect, 'manual'); return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }); } };
  assert.equal(await verifiedDownload(options), destination);
  assert.deepEqual(await readFile(destination), bytes); assert.equal(await verifiedFile(destination, resource), true);
  assert.equal(progress.at(-1), 100); assert.equal(progress.every(value => Number.isInteger(value) && value >= 0 && value <= 100), true);
  assert.deepEqual(await readdir(directory), ['synthetic.gguf']);
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
  await verifiedDownload(options); assert.equal(calls, 1);
});

test('hash, truncated stream, oversized stream and content-length mismatches never install partial models', async t => {
  for (const [name, body, headers] of [
    ['hash mismatch', Buffer.alloc(bytes.length, 1), {}],
    ['truncated body', bytes.subarray(0, -1), {}],
    ['oversized body', Buffer.concat([bytes, Buffer.from('x')]), {}],
    ['wrong content length', bytes, { 'content-length': String(bytes.length + 1) }],
  ]) {
    const { directory, destination } = await fixture(t);
    await assert.rejects(verifiedDownload({ ...resource, destination, fetchImpl: async () => new Response(body, { headers }) }), /integrity|size/, name);
    await empty(directory);
  }
});

test('invalid pin metadata and unapproved initial origins are refused before any fetch', async t => {
  const { directory, destination } = await fixture(t);
  for (const invalid of [
    { url: 'http://registry.ollama.ai/model' }, { url: 'https://evil.example/model' },
    { url: 'https://user:password@github.com/model' }, { url: 'https://github.com:8443/model' },
    { url: 'https://github.com.evil.example/model' }, { size: 0 }, { size: 2_000_000_001 },
    { size: 1.5 }, { sha256: 'unverified' },
  ]) {
    await assert.rejects(verifiedDownload({ ...resource, ...invalid, destination, fetchImpl: async () => { assert.fail('An invalid pin must not make a request.'); } }), /Invalid pinned/);
  }
  await empty(directory);
});

test('approved HTTPS redirects are followed manually and redirected response bodies are cancelled', async t => {
  const { destination } = await fixture(t); const requested = []; let cancelled = false;
  await verifiedDownload({ ...resource, destination, fetchImpl: async (url, options) => {
    requested.push(url); assert.equal(options.redirect, 'manual');
    if (requested.length === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 307, headers: { location: 'https://models.r2.cloudflarestorage.com/pinned' } });
    return streamed([bytes.subarray(0, 10), bytes.subarray(10)]);
  } });
  assert.equal(cancelled, true); assert.deepEqual(requested, [resource.url, 'https://models.r2.cloudflarestorage.com/pinned']);
  assert.equal(await verifiedFile(destination, resource), true);
});

test('redirects cannot reach local HTTP, unapproved hosts or an unbounded redirect chain', async t => {
  for (const location of ['http://127.0.0.1/private', 'https://evil.example/model', 'https://github.com.evil.example/model']) {
    const { directory, destination } = await fixture(t); let calls = 0;
    await assert.rejects(verifiedDownload({ ...resource, destination, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } }), /unapproved host/);
    assert.equal(calls, 1); await empty(directory);
  }
  const { directory, destination } = await fixture(t); let calls = 0;
  await assert.rejects(verifiedDownload({ ...resource, destination, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: resource.url } }); } }), /too many times/);
  assert.equal(calls, 6); await empty(directory);
});

test('an existing corrupt model is preserved instead of overwritten by a download', async t => {
  const { destination } = await fixture(t); const original = Buffer.from('Preserve this existing resource.'); await writeFile(destination, original);
  await assert.rejects(verifiedDownload({ ...resource, destination, fetchImpl: async () => { assert.fail('Existing unverified files must not trigger a replacement download.'); } }), /existing resource failed verification/);
  assert.deepEqual(await readFile(destination), original);
});

test('linked model destinations are refused and their target remains unchanged', async t => {
  const { directory, destination } = await fixture(t); const target = join(directory, 'original.gguf'); await writeFile(target, bytes);
  try { await symlink(target, destination); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows runner does not permit file symlinks.'); return; } throw error; }
  await assert.rejects(verifiedFile(destination, resource), /linked or non-file/);
  await assert.rejects(verifiedDownload({ ...resource, destination, fetchImpl: async () => { assert.fail('A linked destination must not make a request.'); } }), /linked or non-file/);
  assert.deepEqual(await readFile(target), bytes);
});

test('cancelling a streamed model download removes its temporary file', async t => {
  const { directory, destination } = await fixture(t), controller = new AbortController();
  await assert.rejects(verifiedDownload({ ...resource, destination, signal: controller.signal, onProgress: () => controller.abort(), fetchImpl: async () => streamed([bytes.subarray(0, 10), bytes.subarray(10)]) }), { name: 'AbortError' });
  await empty(directory);
});

test('cancelling after the final chunk cannot commit a verified model', async t => {
  const { directory, destination } = await fixture(t), controller = new AbortController();
  await assert.rejects(verifiedDownload({ ...resource, destination, signal: controller.signal, onProgress: percent => { if (percent === 99) controller.abort(); }, fetchImpl: async () => new Response(bytes) }), { name: 'AbortError' });
  await empty(directory);
});
