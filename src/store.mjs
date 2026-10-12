import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, InputError, journalInput, newEntry, text } from './schema.mjs';

export async function openStore({ directory, vault, encryptionKey, clock = () => new Date().toISOString() }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The data directory must be a real private directory.');
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  directory = await realpath(directory);
  const filename = join(directory, 'journal.db');
  const dbStat = await lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (dbStat?.isSymbolicLink()) throw new Error('Refusing a linked Journal database.');
  const key = encryptionKey ?? await loadKey(directory, filename, dbStat, vault);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid Journal encryption key.');
  const db = new DatabaseSync(filename, { timeout: 5000 });
  if (process.platform !== 'win32') await chmod(filename, 0o600);
  // Rollback journal mode avoids a plaintext WAL; all stored payloads are encrypted.
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,cipher TEXT NOT NULL,PRIMARY KEY(kind,id));');
  function encrypt(kind, id, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${kind}:${id}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  function decrypt(row) {
    if (!row) return null;
    const bytes = Buffer.from(row.cipher, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${row.kind}:${row.id}`)); decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }
  const get = (kind, id) => decrypt(db.prepare('SELECT * FROM records WHERE kind=? AND id=?').get(kind, id));
  const all = kind => db.prepare('SELECT * FROM records WHERE kind=? ORDER BY id').all(kind).map(decrypt);
  const put = (kind, id, value) => db.prepare('INSERT INTO records(kind,id,version,cipher) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,cipher=excluded.cipher').run(kind, id, value.version ?? 1, encrypt(kind, id, value));
  function transaction(action) { db.exec('BEGIN IMMEDIATE'); try { const value = action(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  transaction(() => {
    const stored = get('settings', 'main');
    if (!stored) put('settings', 'main', { ...DEFAULT_SETTINGS, listenerId: randomUUID(), version: 1 });
    else if ('policy' in stored || 'authorizationId' in stored || !stored.risk || !('maxTicketUsd' in stored.risk) || !('maxLeverage' in stored.risk)) {
      // 0.2.0-preview.1 used a BTC-only policy lane. Its fields are retired and
      // execution restarts off so the owner reviews the new risk settings.
      const { policy: _policy, authorizationId: _authorizationId, budgetUsd: _budget, ...rest } = stored;
      put('settings', 'main', { ...DEFAULT_SETTINGS, ...rest, executionEnabled: false, risk: { ...DEFAULT_SETTINGS.risk, ...rest.risk }, maxSignalAgeSeconds: Math.max(rest.maxSignalAgeSeconds ?? 0, DEFAULT_SETTINGS.maxSignalAgeSeconds), version: stored.version + 1 });
    }
    // Retired policy attempts remain unresolved; upgrading must never hide them
    // or reinterpret their original body as a basic-order request.
    for (const attempt of all('attempt').filter(row => (!row.kind || row.kind === 'legacy') && ['pending', 'unknown'].includes(row.status))) {
      if (!attempt.kind) put('attempt', attempt.id, { ...attempt, kind: 'legacy' });
      const activityId = 'legacy-' + createHash('sha256').update(attempt.id).digest('hex');
      if (!get('activity', activityId)) put('activity', activityId, {
        id: activityId, kind: 'legacy', attemptId: attempt.id, entryId: attempt.entryId,
        title: 'Earlier execution result needs review', decision: 'review', status: 'unknown', atUtc: clock(),
        reason: `A retired listener submission is unconfirmed. Check its orders, fills and positions in Flusso before marking it resolved. Original retry key: ${attempt.idempotencyKey ?? attempt.id}. It will never be resent.`,
      });
    }
    if (!all('notebook').length) { const id = randomUUID(); put('notebook', `local:${id}`, { id, name: 'My Journal', origin: 'local', version: 1, telegramEnabled: false }); }
  });
  return {
    directory, get, all, put, delete: (kind, id) => db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id),
    settings: () => get('settings', 'main'),
    saveSettings(value) { return transaction(() => { const old = get('settings', 'main'); if (value.version !== old.version) throw new InputError('Settings changed. Reload before saving.', 409); const next = { ...old, ...value, version: old.version + 1 }; put('settings', 'main', next); return next; }); },
    notebooks: () => all('notebook'),
    createNotebook(name) { const id = randomUUID(), row = { id, name: text(name, 120, 'notebook name').trim(), origin: 'local', version: 1, telegramEnabled: false }; put('notebook', `local:${id}`, row); return row; },
    entries: () => all('entry').sort((a, b) => b.updatedAtUtc.localeCompare(a.updatedAtUtc)),
    entry: (id, origin = 'local') => get('entry', `${origin}:${id}`),
    createEntry(input, retryKey = randomUUID()) { return transaction(() => {
      text(retryKey, 200, 'retry key'); const validated = journalInput(input), digest = createHash('sha256').update(JSON.stringify(validated)).digest('hex');
      const old = get('retry', retryKey); if (old) { if (old.digest !== digest) throw new InputError('Retry key was used for different content.', 409); return get('entry', old.entryKey); }
      if (!get('notebook', `local:${validated.notebookId}`)) throw new InputError('Local notebook not found.', 404);
      const entry = { ...newEntry(validated, clock()), origin: 'local' }, entryKey = `local:${entry.id}`;
      put('entry', entryKey, entry); put('retry', retryKey, { digest, entryKey }); return entry;
    }); },
    updateEntry(id, input) { return transaction(() => {
      const old = get('entry', `local:${id}`); if (!old) throw new InputError('Local entry not found.', 404);
      const validated = journalInput(input, { update: true }); if (old.version !== validated.version) throw new InputError('Entry changed. Read its latest version before editing.', 409);
      if (!get('notebook', `local:${validated.notebookId}`)) throw new InputError('Local notebook not found.', 404);
      const entry = { ...old, ...validated, signal: 'signal' in validated ? validated.signal : old.signal, version: old.version + 1, updatedAtUtc: clock() };
      put('entry', `local:${id}`, entry); return entry;
    }); },
    importCloud({ notebooks, entries }) { return transaction(() => {
      for (const notebook of notebooks) put('notebook', `cloud:${notebook.id}`, { ...notebook, origin: 'cloud' });
      for (const entry of entries) { journalInput(entryPayload(entry)); put('entry', `cloud:${entry.id}`, { ...entry, origin: 'cloud' }); }
    }); },
    claimAttempt(attempt) { return transaction(() => {
      if (get('signal-attempt', attempt.signalIdentity)) return false;
      put('signal-attempt', attempt.signalIdentity, { attemptId: attempt.id, atUtc: attempt.atUtc });
      put('attempt', attempt.id, attempt); return true;
    }); },
    close() { db.close(); key.fill(0); },
  };
}
function entryPayload(entry) { return Object.fromEntries(['notebookId', 'title', 'body', 'instrument', 'venue', 'status', 'source', 'observedAtUtc', 'signal'].filter(key => key in entry).map(key => [key, entry[key]])); }
async function loadKey(directory, filename, dbStat, vault) {
  if (!vault) throw new Error('An OS credential store is required.');
  let stored = await vault.get('journal-encryption-key');
  if (stored) return Buffer.from(stored, 'base64');
  if (dbStat?.size) throw new Error('The OS key for this Journal is missing. Restore the original keychain; the existing database was preserved.');
  const lockPath = join(directory, 'key.init');
  let lock;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ownerStat = await lstat(lockPath).catch(() => null);
      if (ownerStat?.isSymbolicLink()) throw new Error('Refusing a linked Journal initialization lock.');
      const owner = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
      let dead = false;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; } }
      // An empty lock can result from a crash between exclusive create and metadata write.
      if (!owner && ownerStat && Date.now() - ownerStat.mtimeMs > 30000) dead = true;
      if (dead) {
        const currentStat = await lstat(lockPath).catch(() => null);
        if (currentStat && ownerStat && currentStat.ino === ownerStat.ino && currentStat.dev === ownerStat.dev) await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } else await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (!lock) throw new Error('Another process is initializing this Journal. Retry shortly; see README recovery guidance if a crashed lock remains.');
  try {
    stored = await vault.get('journal-encryption-key');
    if (!stored) { stored = randomBytes(32).toString('base64'); await vault.set('journal-encryption-key', stored); }
    return Buffer.from(stored, 'base64');
  } finally { await lock.close(); await unlink(lockPath); }
}
