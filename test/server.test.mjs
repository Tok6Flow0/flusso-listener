import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../src/server.mjs';
import { workspace, fakeCloud, note, accountId, notebookId, now } from './helpers.mjs';

async function appFixture(cloudOverrides = {}) {
  const w = await workspace();
  const cloud = fakeCloud(cloudOverrides);
  const listener = { status: () => ({}), refresh: () => {}, tick: async () => {} };
  const app = await startServer({ store: w.store, cloud, listener, checkModel: async () => ({ installed: true }) });
  let csrf, cookie;
  const post = async (path, body, headers = {}) => fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie, 'x-flusso-csrf': csrf } : {}), ...headers }, body: JSON.stringify(body) });
  const unlock = async () => { const response = await post('/api/bootstrap', {}, { Authorization: 'Bearer ' + new URL(app.url).hash.slice(1) }); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrf; return response; };
  return { ...w, app, cloud, post, unlock, cookie: () => cookie, close: async () => { await app.close(); await w.close(); } };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function settingsBody(store, additions = {}) {
  const { model: _model, listenerId: _listenerId, settingsRevision: _revision, ...body } = store.settings();
  return { ...body, ...additions };
}
test('loopback GUI refuses wrong Host/Origin and unauthorized requests; session can reopen with private per-start launcher', async () => {
  const w = await appFixture(); try {
    assert.equal((await fetch(w.app.origin + '/api/status')).status, 401);
    assert.equal((await w.post('/api/bootstrap', {}, { Origin: 'https://evil.example', Authorization: 'Bearer ' + new URL(w.app.url).hash.slice(1) })).status, 403);
    assert.equal((await w.unlock()).status, 200);
    assert.equal((await w.unlock()).status, 200);
    const session = await fetch(w.app.origin + '/api/session', { headers: { Cookie: w.cookie() } }); assert.equal(session.status, 200);
    const headers = await new Promise((resolve, reject) => { const req = http.request(w.app.origin + '/', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }); assert.equal(headers, 403);
    assert.equal((await w.post('/api/notebooks', { name: 'Bad CSRF' }, { 'x-flusso-csrf': 'é'.repeat(43) })).status, 403);
    const staticResponse = await fetch(w.app.origin + '/'); assert.match(staticResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(staticResponse.headers.get('access-control-allow-origin'), null);
  } finally { await w.close(); }
});
test('authorized local Journal save/readback and version conflict flow use the same private store', async () => {
  const w = await appFixture(); try {
    await w.unlock(); const response = await w.post('/api/entries', note(w.store), { 'Idempotency-Key': 'original-api-research-key' }); assert.equal(response.status, 201); const saved = await response.json();
    const status = await fetch(w.app.origin + '/api/status', { headers: { Cookie: w.cookie() } }).then(row => row.json()); assert.equal(status.entries[0].id, saved.id);
    assert.equal((await w.post('/api/entries/' + saved.id, { ...note(w.store), version: 10 })).status, 409);
    assert.equal((await w.post('/api/entries', { ...note(w.store), execute: true })).status, 400);
  } finally { await w.close(); }
});
test('auto-trade needs a write connection and an account this connection owns', async () => {
  let scopes = ['mcp:read'];
  const w = await appFixture({ status: async () => ({ connected: true, clientId: 'fixture-client', scopes }) }); try {
    await w.unlock();
    const risk = { maxSlippagePct: 3, maxOrderUsd: 100, maxTicketUsd: 200, maxLeverage: 10, minVolume24hUsd: null, together: true };
    assert.equal((await w.post('/api/settings', settingsBody(w.store, { enabled: true, executionEnabled: true, notebookIds: [w.store.notebooks()[0].id], accountId, risk }))).status, 400);
    scopes = ['mcp:read', 'mcp:write'];
    for (const field of ['maxOrderUsd', 'maxTicketUsd', 'maxLeverage'])
      assert.equal((await w.post('/api/settings', settingsBody(w.store, { enabled: true, executionEnabled: true, notebookIds: [w.store.notebooks()[0].id], accountId, risk: { ...risk, [field]: null } }))).status, 400);
    assert.equal((await w.post('/api/settings', settingsBody(w.store, { enabled: true, executionEnabled: true, notebookIds: [w.store.notebooks()[0].id], accountId: null, risk }))).status, 400);
    assert.equal((await w.post('/api/settings', settingsBody(w.store, { enabled: true, executionEnabled: true, notebookIds: [w.store.notebooks()[0].id], accountId: notebookId, risk }))).status, 400);
    assert.equal((await w.post('/api/settings', settingsBody(w.store, { enabled: true, executionEnabled: true, notebookIds: [w.store.notebooks()[0].id], accountId, risk: { ...risk, maxSlippagePct: 0 } }))).status, 400);
    assert.equal((await w.post('/api/settings', settingsBody(w.store, { enabled: true, executionEnabled: true, notebookIds: [w.store.notebooks()[0].id], accountId, risk }))).status, 200);
    assert.equal(w.store.settings().executionEnabled, true); assert.deepEqual(w.store.settings().risk, risk);
    const accounts = await fetch(w.app.origin + '/api/accounts', { headers: { Cookie: w.cookie() } }).then(row => row.json()); assert.equal(accounts.accounts[0].id, accountId);
  } finally { await w.close(); }
});
test('only an unconfirmed order result can be marked resolved, and its ticket stays claimed', async () => {
  const w = await appFixture(); try {
    await w.unlock();
    w.store.put('attempt', 'listener-unknown-key', { id: 'listener-unknown-key', kind: 'orders', status: 'unknown', signalIdentity: 'claimed', orders: [], atUtc: new Date(now).toISOString() });
    w.store.put('attempt', 'listener-sent-key', { id: 'listener-sent-key', kind: 'orders', status: 'submitted', orders: [], atUtc: new Date(now).toISOString() });
    assert.equal((await w.post('/api/attempts/listener-sent-key/resolve', {})).status, 404);
    assert.equal((await w.post('/api/attempts/listener-unknown-key/resolve', {})).status, 200);
    assert.equal(w.store.get('attempt', 'listener-unknown-key').status, 'resolved');
  } finally { await w.close(); }
});
test('retired unconfirmed attempts stay visible and owner-resolvable without changing their frozen request or claim', async () => {
  const w = await appFixture(); try {
    await w.unlock();
    const legacy = { id: 'listener-retired-key', kind: 'legacy', status: 'unknown', signalIdentity: 'retired-source', idempotencyKey: 'listener-retired-key', body: { original: 'Frozen retired policy request.' }, atUtc: '2026-10-01T00:00:00Z' };
    w.store.claimAttempt(legacy);
    w.store.put('activity', 'legacy-held-row', { id: 'legacy-held-row', kind: 'legacy', attemptId: legacy.id, title: 'Earlier execution result needs review', status: 'unknown', atUtc: legacy.atUtc, reason: 'Inspect the original retry key in Flusso.' });
    for (let i = 0; i < 105; i++) {
      const id = `recent-order-${i}`;
      w.store.put('attempt', id, { id, kind: 'orders', status: 'submitted', orders: [], atUtc: new Date(now).toISOString() });
      w.store.put('activity', id, { id, title: id, status: 'submitted', atUtc: new Date(now).toISOString() });
    }
    const status = await fetch(w.app.origin + '/api/status', { headers: { Cookie: w.cookie() } }).then(row => row.json());
    assert.equal(status.activity[0].attemptId, legacy.id); assert.equal(status.attempts[0].id, legacy.id);
    assert.deepEqual(status.attempts[0].orders, []); assert.deepEqual(status.attempts[0].body, legacy.body);
    assert.equal((await w.post(`/api/attempts/${legacy.id}/resolve`, {})).status, 200);
    assert.equal(w.store.get('attempt', legacy.id).status, 'resolved');
    assert.deepEqual(w.store.get('attempt', legacy.id).body, legacy.body);
    assert.equal(w.store.get('activity', 'legacy-held-row').status, 'resolved');
    assert.equal(w.store.claimAttempt({ ...legacy, id: 'replacement' }), false);
    assert.equal((await w.post(`/api/attempts/${legacy.id}/resolve`, {})).status, 404);
  } finally { await w.close(); }
});
test('appearance is saved locally and applied before first paint', async () => {
  const w = await appFixture(); try {
    await w.unlock();
    assert.equal((await w.post('/api/display', { theme: 'neon' })).status, 400);
    assert.equal((await w.post('/api/display', { theme: 'atlantic' })).status, 200);
    assert.match(await fetch(w.app.origin + '/').then(row => row.text()), /<html lang="en" data-theme-mode="atlantic" data-theme="atlantic">/);
    const status = await fetch(w.app.origin + '/api/status', { headers: { Cookie: w.cookie() } }).then(row => row.json());
    assert.equal(status.display.theme, 'atlantic');
  } finally { await w.close(); }
});
test('pending browser connection refuses settings changes and finishes with execution off', async () => {
  const started = deferred(), finish = deferred(); let clientId = 'fixture-client';
  const w = await appFixture({
    status: async () => ({ connected: true, clientId, scopes: ['mcp:read', 'mcp:write'] }),
    beginConnect: async () => { started.resolve(); await finish.promise; clientId = 'replacement-client'; return { connected: true, clientId }; },
  });
  try {
    await w.unlock();
    const risk = { maxSlippagePct: 3, maxOrderUsd: 100, maxTicketUsd: 200, maxLeverage: 10, minVolume24hUsd: null, together: true };
    assert.equal((await w.post('/api/settings', settingsBody(w.store, { enabled: true, executionEnabled: true, notebookIds: [w.store.notebooks()[0].id], accountId, risk }))).status, 200);
    const connecting = w.post('/api/connect', {}); await started.promise;
    assert.equal((await w.post('/api/settings', settingsBody(w.store, { enabled: true, executionEnabled: true, notebookIds: [w.store.notebooks()[0].id], accountId, risk }))).status, 409);
    assert.equal((await w.post('/api/sync', {})).status, 409);
    finish.resolve(); assert.equal((await connecting).status, 200);
    assert.equal(w.store.settings().enabled, false); assert.equal(w.store.settings().executionEnabled, false);
    assert.equal(w.store.settings().accountId, null);
    assert.equal((await w.cloud.status()).clientId, 'replacement-client');
  } finally { finish.resolve(); await w.close(); }
});
test('disconnect cancels pending browser connection without restoring authority', async () => {
  const started = deferred(), finish = deferred(); let connected = true;
  const w = await appFixture({
    status: async () => ({ connected, clientId: 'fixture-client' }),
    beginConnect: async () => { started.resolve(); await finish.promise; return { connected: true, clientId: 'replacement-client' }; },
    disconnect: async () => { connected = false; },
  });
  try {
    await w.unlock(); const connecting = w.post('/api/connect', {}); await started.promise;
    assert.equal((await w.post('/api/disconnect', {})).status, 200);
    finish.resolve(); assert.equal((await connecting).status, 409);
    assert.equal(w.store.settings().executionEnabled, false); assert.equal(w.store.settings().accountId, null);
  } finally { finish.resolve(); await w.close(); }
});

test('manual sync never imports an old account snapshot after reconnect or disconnect', async () => {
  for (const change of ['connect', 'disconnect']) {
    const started = deferred(), finish = deferred(); let clientId = 'fixture-client', connected = true;
    const w = await appFixture({
      status: async () => ({ connected, clientId }),
      readJournal: async () => {
        started.resolve(); await finish.promise;
        return { notebooks: [{ id: notebookId, name: 'Old account research', version: 1 }], entries: [{ ...note(w.store), id: accountId, notebookId, version: 1, createdAtUtc: new Date(now).toISOString(), updatedAtUtc: new Date(now).toISOString() }], complete: true };
      },
      beginConnect: async () => { clientId = 'replacement-client'; return { connected, clientId }; },
      disconnect: async () => { connected = false; },
    });
    try {
      await w.unlock(); const syncing = w.post('/api/sync', {}); await started.promise;
      assert.equal((await w.post('/api/' + change, {})).status, 200);
      finish.resolve(); assert.equal((await syncing).status, 409);
      assert.equal(w.store.entries().length, 0);
      assert.equal(w.store.notebooks().some(row => row.origin === 'cloud'), false);
    } finally { finish.resolve(); await w.close(); }
  }
});

test('unconfirmed close attempts stay visible and owner-resolvable with their original positions and durable claim', async () => {
  const w = await appFixture();
  try {
    await w.unlock();
    const attempt = { id: 'listener-close-unknown-key', kind: 'close', status: 'unknown', signalIdentity: 'close-original-claim', idempotencyKey: 'listener-close-unknown-key', positionIds: ['d93d1eec-2a5e-f058-b846-d12fd573ae1d'], orders: [], atUtc: '2026-10-01T00:00:00Z' };
    w.store.claimAttempt(attempt);
    w.store.put('activity', 'close-unknown-row', { id: 'close-unknown-row', attemptId: attempt.id, status: 'unknown', title: 'Close waiting for reconciliation', atUtc: attempt.atUtc });
    for (let i = 0; i < 105; i++) w.store.put('activity', `newer-${i}`, { id: `newer-${i}`, title: 'Newer completed action', status: 'submitted', atUtc: new Date(now).toISOString() });
    const status = await fetch(w.app.origin + '/api/status', { headers: { Cookie: w.cookie() } }).then(row => row.json());
    assert.equal(status.attempts[0].kind, 'close'); assert.deepEqual(status.attempts[0].positionIds, attempt.positionIds);
    assert.equal(status.activity[0].attemptId, attempt.id, 'Unconfirmed closes cannot disappear behind newer rows.');
    assert.equal((await w.post(`/api/attempts/${attempt.id}/resolve`, {})).status, 200);
    const retained = w.store.get('attempt', attempt.id);
    assert.equal(retained.status, 'resolved'); assert.deepEqual(retained.positionIds, attempt.positionIds); assert.equal(retained.idempotencyKey, attempt.idempotencyKey);
    assert.equal(w.store.get('activity', 'close-unknown-row').status, 'resolved');
    assert.equal(w.store.claimAttempt({ ...attempt, id: 'replacement' }), false);
    assert.equal((await w.post(`/api/attempts/${attempt.id}/resolve`, {})).status, 404);
  } finally { await w.close(); }
});
