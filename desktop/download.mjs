import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

function allowed(url) {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port &&
    (['github.com', 'registry.ollama.ai'].includes(parsed.hostname) || parsed.hostname.endsWith('.githubusercontent.com') || parsed.hostname.endsWith('.r2.cloudflarestorage.com'));
}
export async function verifiedFile(path, { size, sha256 }) {
  const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing a linked or non-file model resource.');
  if (stat.size !== size) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === sha256;
}
export async function verifiedDownload({ url, destination, size, sha256, onProgress = () => {}, signal, fetchImpl = fetch }) {
  signal?.throwIfAborted();
  if (!allowed(url) || !Number.isSafeInteger(size) || size < 1 || size > 2_000_000_000 || !/^[a-f\d]{64}$/.test(sha256)) throw new Error('Invalid pinned download resource.');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (await verifiedFile(destination, { size, sha256 })) return destination;
  const existing = await lstat(destination).catch(() => null);
  if (existing) throw new Error('An existing resource failed verification. Move that model file aside before downloading again. Your Journal is unchanged.');
  let next = url, response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetchImpl(next, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error('The resource download redirected too many times.');
    next = new URL(location, next).href;
    if (!allowed(next)) throw new Error('The resource download redirected to an unapproved host.');
  }
  if (!response.ok || !response.body || response.headers.has('content-length') && Number(response.headers.get('content-length')) !== size) throw new Error('The resource download was unavailable or had an unexpected size.');
  const temporary = `${destination}.${randomUUID()}.part`;
  const file = await open(temporary, 'wx', 0o600);
  let received = 0, previous = -1;
  const hash = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted(); received += chunk.length;
      if (received > size) throw new Error('The resource download exceeded its pinned size.');
      hash.update(chunk); await file.writeFile(chunk);
      const percent = Math.min(99, Math.floor(received / size * 100));
      if (percent !== previous) { previous = percent; onProgress(percent); }
    }
    if (received !== size || hash.digest('hex') !== sha256) throw new Error('The resource failed its integrity check. Nothing was installed.');
    signal?.throwIfAborted(); await file.sync(); await file.close(); signal?.throwIfAborted();
    await rename(temporary, destination); onProgress(100); return destination;
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
