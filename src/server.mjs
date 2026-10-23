import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InputError, ID, object, settingsInput, text, THEMES } from './schema.mjs';
import { listenCallback, openBrowser } from './browser.mjs';
import { modelStatus, MODEL_BODY_LIMIT } from './model.mjs';
import { readTicket } from './orders.mjs';
import { describeEntryHandoff } from './handoff.mjs';

const STATUS_LIMITS = Object.freeze({ entries: 500, activity: 100, attempts: 100, modelBodyUnits: MODEL_BODY_LIMIT });

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/tokens.css', ['tokens.css', 'text/css; charset=utf-8']],
  ['/format.mjs', ['format.mjs', 'text/javascript; charset=utf-8']], ['/flusso-mark.png', ['flusso-mark.png', 'image/png']],
  ['/markdown.mjs', ['markdown.mjs', 'text/javascript; charset=utf-8']],
  ['/desktop-ui.mjs', ['desktop-ui.mjs', 'text/javascript; charset=utf-8']],
  ...['HankenGrotesk-400.ttf', 'HankenGrotesk-600.ttf', 'Newsreader-500.ttf', 'IBMPlexMono-400.ttf'].map(name => [`/fonts/${name}`, [`fonts/${name}`, 'font/ttf']]),
]);
export async function startServer({ store, cloud, listener, port = 0, open = openBrowser, callback = listenCallback, checkModel = modelStatus, clock = Date.now }) {
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
      // The existing authenticated status resource also pushes Listener state.
      // Notes and account/profile reads stay on the normal bounded JSON path.
      if (request.method === 'GET' && url.pathname === '/api/status' && request.headers.accept === 'text/event-stream') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        const send = state => {
          if (response.destroyed) return;
          if (response.writableLength > 262144) { response.destroy(); return; }
          response.write(`data: ${JSON.stringify(state)}\n\n`);
        };
        const unsubscribe = listener.subscribe(send);
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15000);
        response.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
        send(listener.status());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        const connection = await cloud.status(), model = await checkModel(), current = listener.status();
        const activity = store.all('activity').map(row => row.kind === 'research_check' && row.status === 'processing'
          ? { ...row, activeReview: Boolean(row.checkId != null && current.busy && row.checkId === current.modelReview?.id) } : row);
        return reply(200, { limits: STATUS_LIMITS, settings: store.settings(), listener: current, cloud: connection, model, display: { theme: theme() }, notebooks: store.notebooks(), entries: annotate(store.entries().slice(0, STATUS_LIMITS.entries), activity, store, clock(), current), activity: activity.sort((a, b) => Number(unconfirmed(b)) - Number(unconfirmed(a)) || newest(a, b)).slice(0, STATUS_LIMITS.activity), attempts: store.all('attempt').filter(row => ['orders', 'close', 'legacy'].includes(row.kind)).sort((a, b) => Number(unconfirmed(b)) - Number(unconfirmed(a)) || newest(a, b)).slice(0, STATUS_LIMITS.attempts).map(row => ({ ...row, orders: row.orders ?? [] })) });
      }
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
        if (!attempt || !['orders', 'close', 'legacy'].includes(attempt.kind) || !unconfirmed(attempt)) throw new InputError('Only an unconfirmed order or close result can be marked resolved.', 404);
        // The owner checked Flusso. The durable claim stays, so the ticket is never re-sent.
        store.put('attempt', attempt.id, { ...attempt, status: 'resolved', resolvedAtUtc: new Date().toISOString() });
        for (const activity of store.all('activity').filter(row => row.attemptId === attempt.id))
          store.put('activity', activity.id, { ...activity, status: 'resolved', reason: 'The owner marked this earlier result resolved after checking Flusso. Its original request and retry key remain retained; it will never be resent.' });
        listener.refresh(); return reply(200, { resolved: true });
      }
      if (url.pathname === '/api/display' && request.method === 'POST') {
        object(input, ['theme']);
        if (!THEMES.includes(input.theme)) throw new InputError('Choose an available appearance.');
        store.put('display', 'main', { theme: input.theme }); return reply(200, { theme: input.theme });
      }
      if (url.pathname === '/api/check' && request.method === 'POST') { object(input, []); await listener.tick({ reviewLatest: true }); return reply(200, listener.status()); }
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
      if (url.pathname === '/api/entries' && request.method === 'POST') return reply(201, annotate([store.createEntry(input, request.headers['idempotency-key'] ?? randomUUID())], store.all('activity'), store, clock(), listener.status())[0]);
      if (/^\/api\/entries\/[a-f\d-]+$/i.test(url.pathname) && request.method === 'POST') return reply(200, annotate([store.updateEntry(url.pathname.split('/').at(-1), input)], store.all('activity'), store, clock(), listener.status())[0]);
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
function annotate(entries, activity, store, now, listenerState = {}) {
  const settings = store.settings();
  const latest = new Map(), acceptedResearch = new Map(), researchChecks = new Map(), attempts = new Map();
  for (const row of store.all('attempt')) {
    const key = `${row.origin}:${row.entryId}:${row.version}`;
    if (!attempts.has(key)) attempts.set(key, []);
    attempts.get(key).push(row);
  }
  for (const row of activity) {
    const key = `${row.origin}:${row.entryId}`, seen = latest.get(key);
    if (!seen || row.atUtc > seen.atUtc) latest.set(key, row);
    if (row.kind === 'research_check') {
      const versionKey = `${key}:${row.version}`, seenCheck = researchChecks.get(versionKey);
      if (!seenCheck || row.atUtc > seenCheck.atUtc) researchChecks.set(versionKey, row);
    }
    if (row.status === 'observed' && ['candidate', 'review', 'ignore'].includes(row.decision)) {
      const accepted = acceptedResearch.get(key);
      const clock = row.completedAtUtc ?? row.atUtc, priorClock = accepted?.completedAtUtc ?? accepted?.atUtc;
      if (!accepted || clock > priorClock || clock === priorClock && row.version > accepted.version) acceptedResearch.set(key, row);
    }
  }
  return entries.map(entry => {
    const ticket = readTicket(entry.body);
    const key = `${entry.origin}:${entry.id}`, row = (ticket === null ? acceptedResearch.get(key) : null) ?? latest.get(key);
    const handoff = describeEntryHandoff({ entry, settings, ticket, activity: row, attempts: attempts.get(`${entry.origin}:${entry.id}:${entry.version}`), checkpoint: store.get('checkpoint', `${entry.origin}:${entry.id}`), now });
    const annotation = value => value ? { decision: value.decision ?? null, status: value.status, reason: value.reason ?? null, atUtc: value.atUtc, version: value.version ?? null, focus: value.focus ?? null,
      ...(value.kind === 'research_check' ? { kind: value.kind, reviewStatus: value.reviewStatus ?? null, responseReceived: value.responseReceived === true, activeReview: Boolean(value.checkId != null && listenerState.busy && value.checkId === listenerState.modelReview?.id) } : {}) } : null;
    const check = ticket === null ? researchChecks.get(`${key}:${entry.version}`) : null;
    const separateCheck = check && (row?.kind === 'research_check' || check.id !== row?.id && check.checkId !== row?.checkId && (!row || Date.parse(check.atUtc) >= Date.parse(row.completedAtUtc ?? row.atUtc)));
    return { ...entry, ticket, handoff, listener: annotation(row), listenerCheck: separateCheck ? annotation(check) : null };
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
