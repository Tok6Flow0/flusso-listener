import { open, readFile, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// One refresh-token rotator and one admission loop per private data directory.
export async function claimInstance(directory) {
  const filename = join(directory, 'instance.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return async () => { await handle.close(); const owner = await readFile(filename, 'utf8').then(JSON.parse).catch(() => null); if (owner?.pid === process.pid) await unlink(filename).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await lstat(filename); if (stat.isSymbolicLink()) throw new Error('Refusing a linked Listener instance lock.');
      const owner = await readFile(filename, 'utf8').then(JSON.parse).catch(() => null);
      let dead = !owner && Date.now() - stat.mtimeMs > 30000;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; } }
      if (!dead) throw new Error('Another Listener is running. Use node src/cli.mjs open to show its GUI.');
      const current = await lstat(filename).catch(() => null);
      if (current && current.ino === stat.ino && current.dev === stat.dev) await unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  throw new Error('Another Listener is starting. Retry shortly.');
}
