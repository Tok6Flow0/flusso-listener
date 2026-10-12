import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InputError, ID, object, settingsInput, text, THEMES } from './schema.mjs';
import { listenCallback, openBrowser } from './browser.mjs';
import { modelStatus } from './model.mjs';
import { readTicket } from './orders.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/tokens.css', ['tokens.css', 'text/css; charset=utf-8']],
  ['/format.mjs', ['format.mjs', 'text/javascript; charset=utf-8']], ['/flusso-mark.png', ['flusso-mark.png', 'image/png']],
  ['/markdown.mjs', ['markdown.mjs', 'text/javascript; charset=utf-8']],
  ['/desktop-ui.mjs', ['desktop-ui.mjs', 'text/javascript; charset=utf-8']],
  ...['HankenGrotesk-400.ttf', 'HankenGrotesk-600.ttf', 'Newsreader-500.ttf', 'IBMPlexMono-400.ttf'].map(name => [`/fonts/${name}`, [`fonts/${name}`, 'font/ttf']]),
]);
export async function startServer({ store, cloud, listener, port = 0, open = openBrowser, callback = listenCallback, checkModel = modelStatus }) {
  const bootstrap = randomBytes(32).toString('base64url'), session = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  let origin, connectPending = false, connectionGeneration = 0;
  const theme = () => { const saved = store.get('display', 'main')?.theme; return THEMES.includes(saved) ? saved : 'system'; };
  const suspendExecution = () => {
    const settings = store.settings();
    store.saveSettings({ ...settings, enabled: false, executionEnabled: false, accountId: null });
    listener.refresh();
  };
  const requireStableConnection = (generation, before, after) => {
    if (connectPending || generation !== connectionGeneration || !before.connected || !after.connected
      || before.clientId !== after.clientId || before.connectionId !== after.connectionId) {
      throw new InputError('The connection changed. Reload and try again.', 409);
    }
  };
  const unconfirmed = row => ['pending', 'unknown'].includes(row.status);
  const newest = (left, right) => right.atUtc.localeCompare(left.atUtc);
  const server = createServer(async (request, response) => {
    const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== new URL(origin).host || request.url.length > 2048) return reply(403, { error: 'Request host refused.' });
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && assets.has(url.pathname) && !url.search) {
        const [filename, type] = assets.get(url.pathname);
        let content = await readFile(fileURLToPath(new URL(`../public/${filename}`, import.meta.url)));
        // The saved appearance is applied before first paint; it is never user HTML.
        if (filename === 'index.html') { const mode = theme(); content = content.toString('utf8').replace('<html lang="en">', `<html lang="en" data-theme-mode="${mode}"${mode === 'system' ? '' : ` data-theme="${mode}"`}>`); }
        response.writeHead(200, { 'Content-Type': type }); response.end(content); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/bootstrap') {
        if (request.headers.origin !== origin || !same(request.headers.authorization, `Bearer ${bootstrap}`)) return reply(403, { error: 'Reopen the app from its launcher.' });
        response.setHeader('Set-Cookie', `flusso_listener=${session}; HttpOnly; SameSite=Strict; Path=/`);
        return reply(200, { csrf });
      }
      if (!hasSession(request.headers.cookie, session)) return reply(401, { error: 'Open the app from its launcher to unlock this session.' });
      if (!url.pathname.startsWith('/api/') || url.search) return reply(404, { error: 'Route not found.' });
      if (request.method === 'GET' && url.pathname === '/api/session') return reply(200, { csrf });
      if (request.method === 'GET' && url.pathname === '/api/profile') return reply(200, await cloud.profile());
      if (request.method === 'GET' && url.pathname === '/api/accounts') return reply(200, { accounts: await cloud.listAccounts() });
      if (request.method !== 'GET' && (request.method !== 'POST' || request.headers.origin !== origin || !same(request.headers['x-flusso-csrf'], csrf))) return reply(403, { error: 'Request origin or session refused.' });
      if (request.method === 'GET' && url.pathname === '/api/status') return reply(200, { settings: store.settings(), listener: listener.status(), cloud: await cloud.status(), model: await checkModel(), display: { theme: theme() }, notebooks: store.notebooks(), entries: annotate(store.entries().slice(0, 500), store.all('activity')), activity: store.all('activity').sort((a, b) => Number(b.kind === 'legacy' && unconfirmed(b)) - Number(a.kind === 'legacy' && unconfirmed(a)) || newest(a, b)).slice(0, 100), attempts: store.all('attempt').filter(row => ['orders', 'legacy'].includes(row.kind)).sort((a, b) => Number(unconfirmed(b)) - Number(unconfirmed(a)) || newest(a, b)).slice(0, 100).map(row => ({ ...row, orders: row.orders ?? [] })) });
      const input = request.method === 'POST' ? await readJson(request) : null;
      if (url.pathname === '/api/connect' && request.method === 'POST') {
        object(input, []);
        if (connectPending) throw new InputError('Complete the current browser connection first.', 409);
        connectPending = true;
        const generation = ++connectionGeneration;
        try {
          suspendExecution();
          const result = await cloud.beginConnect({ openBrowser: open, listenCallback: callback });
          if (generation !== connectionGeneration) throw new InputError('This connection changed while browser authorization was in progress.', 409);
          suspendExecution();
          // A new identity or grant must never execute cached observations on reconnect.
          store.delete('sync', 'baseline');
          return reply(200, result);
        } finally { connectPending = false; }
      }
      if (url.pathname === '/api/disconnect' && request.method === 'POST') {
        object(input, []); connectionGeneration += 1; suspendExecution(); await cloud.disconnect(); return reply(200, { disconnected: true });
      }
      if (url.pathname === '/api/settings' && request.method === 'POST') {
        if (connectPending) throw new InputError('Finish connecting Flusso before changing Listener settings.', 409);
        const generation = connectionGeneration;
        const next = settingsInput(input), old = store.settings();
        if (next.executionEnabled) {
          const connection = await cloud.status();
          if (!connection.connected || !connection.scopes.includes('mcp:write')) throw new InputError('Connect Flusso with write access before turning on auto-trade.');
          if (!next.accountId) throw new InputError('Choose the trading account auto-trade should use.');
          const accounts = await cloud.listAccounts();
          requireStableConnection(generation, connection, await cloud.status());
          if (!accounts.some(row => row.id.toLowerCase() === next.accountId.toLowerCase())) throw new InputError('That trading account is not available on this connection.');
        }
        const saved = store.saveSettings(next); listener.refresh({ baseline: !old.enabled && saved.enabled }); return reply(200, saved);
      }
      if (/^\/api\/attempts\/[A-Za-z0-9_-]{8,160}\/resolve$/.test(url.pathname) && request.method === 'POST') {
        object(input, []);
        const attempt = store.get('attempt', decodeURIComponent(url.pathname.split('/')[3]));
        if (!attempt || !['orders', 'legacy'].includes(attempt.kind) || !unconfirmed(attempt)) throw new InputError('Only an unconfirmed order result can be marked resolved.', 404);
        // The owner checked Flusso. The durable claim stays, so the ticket is never re-sent.
        store.put('attempt', attempt.id, { ...attempt, status: 'resolved', resolvedAtUtc: new Date().toISOString() });
        for (const activity of store.all('activity').filter(row => row.kind === 'legacy' && row.attemptId === attempt.id))
          store.put('activity', activity.id, { ...activity, status: 'resolved', reason: 'The owner marked this earlier result resolved after checking Flusso. Its original request and retry key remain retained; it will never be resent.' });
        listener.refresh(); return reply(200, { resolved: true });
      }
      if (url.pathname === '/api/display' && request.method === 'POST') {
        object(input, ['theme']);
        if (!THEMES.includes(input.theme)) throw new InputError('Choose an available appearance.');
        store.put('display', 'main', { theme: input.theme }); return reply(200, { theme: input.theme });
      }
      if (url.pathname === '/api/check' && request.method === 'POST') { object(input, []); await listener.tick(); return reply(200, listener.status()); }
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        object(input, []);
        if (connectPending) throw new InputError('Complete the current browser connection before syncing the Journal.', 409);
        const generation = connectionGeneration, connection = await cloud.status();
        const snapshot = await cloud.readJournal({ notebookIds: [] });
        requireStableConnection(generation, connection, await cloud.status());
        store.importCloud(snapshot);
        return reply(200, { complete: snapshot.complete, reason: snapshot.reason ?? null, asOfUtc: snapshot.asOfUtc });
      }
      if (url.pathname === '/api/notebooks' && request.method === 'POST') { object(input, ['name']); return reply(201, store.createNotebook(input.name)); }
      if (url.pathname === '/api/entries' && request.method === 'POST') return reply(201, store.createEntry(input, request.headers['idempotency-key'] ?? randomUUID()));
      if (/^\/api\/entries\/[a-f\d-]+$/i.test(url.pathname) && request.method === 'POST') return reply(200, store.updateEntry(url.pathname.split('/').at(-1), input));
      return reply(404, { error: 'Route not found.' });
    } catch (error) {
      const status = error instanceof InputError ? error.status : error.name === 'CloudError' ? 400 : 500;
      // Never echo arbitrary provider bodies, credentials, stack traces or filenames.
      return reply(status, { error: status === 500 ? 'The request could not be completed. Your stored Journal was preserved.' : error.message });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, url: `${origin}/#${bootstrap}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
// Each entry carries its ticket (if any) and the listener's latest decision on it.
function annotate(entries, activity) {
  const latest = new Map();
  for (const row of activity) {
    const key = `${row.origin}:${row.entryId}`, seen = latest.get(key);
    if (!seen || row.atUtc > seen.atUtc) latest.set(key, row);
  }
  return entries.map(entry => {
    const row = latest.get(`${entry.origin}:${entry.id}`);
    return { ...entry, ticket: readTicket(entry.body), listener: row ? { decision: row.decision ?? null, status: row.status, reason: row.reason ?? null, atUtc: row.atUtc } : null };
  });
}
function same(left, right) { if (typeof left !== 'string') return false; const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function hasSession(cookie, session) { return typeof cookie === 'string' && cookie.split(';').some(part => same(part.trim(), `flusso_listener=${session}`)); }
async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new InputError('Use a JSON request.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 98304) throw new InputError('This request is too large.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('Invalid JSON request.'); }
}
