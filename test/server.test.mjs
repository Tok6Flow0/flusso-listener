import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../src/server.mjs';
import { workspace, fakeCloud, note, accountId, authorizationId, policy, notebookId, now } from './helpers.mjs';

async function appFixture(cloudOverrides = {}) {
  const w = await workspace(), grant = { schemaVersion: 'product.prompt_trading_authorization.v1', accountId, authorizationId, status: 'active', policy, policyHash: 'a'.repeat(64) };
  const cloud = fakeCloud({ confirmPolicy: async () => grant, getPolicy: async () => grant, previewPolicy: async value => ({ previewId: 'test-preview', request: { body: value } }), discoverExecutionChoices: async () => ({ accounts: [{ id: accountId, displayName: 'Test account' }], instruments: [{ instrumentId: policy.instrumentId, symbol: 'BTC/USD', venue: 'coinbase' }], complete: true }), ...cloudOverrides });
  const listener = { status: () => ({}), refresh: () => {}, tick: async () => {} };
  const app = await startServer({ store: w.store, cloud, listener, checkModel: async () => ({ installed: true }) });
  let csrf, cookie;
  const post = async (path, body, headers = {}) => fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie, 'x-flusso-csrf': csrf } : {}), ...headers }, body: JSON.stringify(body) });
  const unlock = async () => { const response = await post('/api/bootstrap', {}, { Authorization: 'Bearer ' + new URL(app.url).hash.slice(1) }); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrf; return response; };
  return { ...w, app, cloud, grant, post, unlock, cookie: () => cookie, close: async () => { await app.close(); await w.close(); } };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function settingsBody(store, additions = {}) {
  const { model: _model, listenerId: _listenerId, policy: _policy, maxSignalAgeSeconds: _age, ...body } = store.settings();
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
test('policy approval saves only the explicit server grant and leaves execution off', async () => {
  const w = await appFixture(); try {
    await w.unlock(); assert.equal((await w.post('/api/policy/approve', { previewId: 'test-preview' })).status, 200);
    assert.equal(w.store.settings().authorizationId, authorizationId); assert.equal(w.store.settings().executionEnabled, false);
    const s = w.store.settings(); const { model: _model, listenerId: _listenerId, policy: _policy, maxSignalAgeSeconds: _age, ...body } = s;
    assert.equal((await w.post('/api/settings', { ...body, enabled: true, executionEnabled: true })).status, 200); assert.equal(w.store.settings().executionEnabled, true);
    const choices = await fetch(w.app.origin + '/api/execution-choices', { headers: { Cookie: w.cookie() } }).then(row => row.json()); assert.equal(choices.accounts[0].id, accountId);
  } finally { await w.close(); }
});
test('pending browser connection refuses settings and policy mutations and finishes with execution off', async () => {
  const started = deferred(), finish = deferred(); let clientId = 'fixture-client';
  const w = await appFixture({
    status: async () => ({ connected: true, clientId }),
    beginConnect: async () => { started.resolve(); await finish.promise; clientId = 'replacement-client'; return { connected: true, clientId }; },
  });
  try {
    await w.unlock();
    assert.equal((await w.post('/api/policy/approve', { previewId: 'test-preview' })).status, 200);
    const connecting = w.post('/api/connect', {}); await started.promise;
    assert.equal((await w.post('/api/settings', settingsBody(w.store, { enabled: true, executionEnabled: true, accountId, authorizationId }))).status, 409);
    assert.equal((await w.post('/api/policy/preview', { accountId, policy })).status, 409);
    assert.equal((await w.post('/api/policy/approve', { previewId: 'test-preview' })).status, 409);
    assert.equal((await w.post('/api/sync', {})).status, 409);
    finish.resolve(); assert.equal((await connecting).status, 200);
    assert.equal(w.store.settings().enabled, false); assert.equal(w.store.settings().executionEnabled, false);
    assert.equal(w.store.settings().authorizationId, null); assert.equal(w.store.settings().policy, null);
    assert.equal((await w.cloud.status()).clientId, 'replacement-client');
  } finally { finish.resolve(); await w.close(); }
});
test('an old in-flight policy approval cannot persist authority after reconnect or disconnect', async () => {
  for (const change of ['connect', 'disconnect']) {
    const started = deferred(), finish = deferred(); let clientId = 'fixture-client', connected = true;
    const w = await appFixture({
      status: async () => ({ connected, clientId }),
      confirmPolicy: async () => { started.resolve(); await finish.promise; return w.grant; },
      beginConnect: async () => { clientId = 'replacement-client'; return { connected, clientId }; },
      disconnect: async () => { connected = false; },
    });
    try {
      await w.unlock();
      const approval = w.post('/api/policy/approve', { previewId: 'test-preview' }); await started.promise;
      assert.equal((await w.post('/api/' + change, {})).status, 200);
      finish.resolve(); assert.equal((await approval).status, 409);
      assert.equal(w.store.get('grant', authorizationId), null);
      assert.equal(w.store.settings().authorizationId, null); assert.equal(w.store.settings().executionEnabled, false);
    } finally { finish.resolve(); await w.close(); }
  }
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
    assert.equal(w.store.settings().executionEnabled, false); assert.equal(w.store.settings().authorizationId, null);
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
