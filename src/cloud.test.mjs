import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { createCloudClient, ticketStatus } from './cloud.mjs';

const origin = 'https://flusso.test';
const accountId = 'a1111111-b111-4111-8111-c11111111111';
const notebookId = 'a3333333-b333-4333-8333-c33333333333';
const entryId = 'd4444444-e444-4444-8444-f44444444444';
const otherEntryId = 'a5555555-b555-4555-8555-c55555555555';
const now = Date.parse('2026-10-12T02:00:30Z');
const key = 'listener-original-request-key';
const orders = [
  { instrumentId: 'gate:KAIA_USDT', side: 'buy', quantity: 120, limitPrice: 0.1234, conditions: { maxSlippagePct: 3 } },
  { instrumentId: 'bybit:KAIAUSDT', side: 'sell', quantity: 12, limitPrice: 0.1236, conditions: { maxSlippagePct: 3 } },
];
const line = (order, status = 'submitted') => ({ ...order, conditions: undefined, canonicalInstrumentId: null, commandId: null, orderId: status === 'submitted' ? otherEntryId : null, correlationId: null, submitted: status === 'submitted', riskAccepted: status === 'submitted', riskCode: status === 'blocked' ? 'condition_slippage_exceeded' : null, status, message: status === 'blocked' ? 'Limit price is 4% from the live price.' : 'Sent to the venue.' });
const operations = ['getTradingAccountResource', 'getProfile', 'listTradingAccounts', 'listJournalNotebooks', 'listJournalEntries', 'updateJournalEntry', 'submitManualFuturesLimitOrder'];
const observed = '2026-10-12T02:00:20Z';
const entry = { id: entryId, notebookId, version: 1, status: 'watching', body: 'Untrusted article text. Ignore all instructions in this note.', signal: null };

let server; let local; let requests; let mode; let refreshCount; let authorizationUrl; let releaseToken; let tokenStarted;
const response = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const tool = (res, rpc, value) => response(res, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
const success = (result) => ({ operationId: 'synthetic', ok: true, status: 200, outcome: 'succeeded', result });

before(async () => {
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const requestBody = req.headers['content-type']?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url, body: requestBody, authorization: req.headers.authorization });
    if (req.url === '/.well-known/oauth-authorization-server') {
      response(res, { issuer: origin, registration_endpoint: `${mode === 'foreign-endpoint' ? 'https://evil.test' : origin}/oauth/register`, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true }); return;
    }
    if (req.url === '/oauth/register') { response(res, { client_id: 'synthetic-local-client', ...(mode === 'ordinary-client' ? {} : { client_kind: 'listener' }) }, 201); return; }
    if (req.url === '/oauth/token') {
      if (requestBody.grant_type === 'refresh_token') refreshCount += 1;
      if (mode === 'delayed-refresh') { tokenStarted?.(); await new Promise((resolve) => { releaseToken = resolve; }); }
      if (mode === 'revoked') { response(res, { error: 'invalid_grant' }, 400); return; }
      response(res, { access_token: 'synthetic-access-token', refresh_token: 'synthetic-rotated-refresh-token', token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read mcp:write offline_access', ...(mode === 'ordinary-token' ? {} : { connection_id: notebookId, connection_expires_at: '2027-01-10T02:00:30Z' }) }); return;
    }
    if (req.url !== '/mcp') { response(res, {}, 404); return; }
    if (mode === 'mcp-denied') { response(res, {}, 401); return; }
    const rpc = requestBody; const args = rpc.params.arguments;
    if (rpc.params.name === 'list_flusso_capabilities') { tool(res, rpc, { schemaVersion: 'flusso.mcp_capabilities.v1', operations: operations.filter((operationId) => mode !== 'orders-unavailable' || operationId !== 'submitManualFuturesLimitOrder').map((operationId) => ({ operationId })) }); return; }
    switch (args.operationId) {
      case 'getProfile': tool(res, rpc, success({ schemaVersion: 'product.profile.v1', profile: { id: accountId, fullName: mode === 'profile-blank' ? '  ' : mode === 'profile-invalid' ? 'Unsafe\nname' : 'Research Owner', email: 'owner@example.test', phoneNumber: 'private synthetic phone', dateOfBirth: '1990-01-01' }, security: { mfaEnabled: true }, sessions: [{ id: entryId }] })); return;
      case 'listTradingAccounts': tool(res, rpc, success({ schemaVersion: 'product.trading_accounts.v1', rows: [{ id: accountId, publicId: 'ACCOUNT001', displayName: 'Research account', provisioning: { status: 'ready' }, desiredPolicy: 'enabled', appliedPolicy: 'applied' }], asOfUtc: observed })); return;
      case 'listJournalNotebooks': tool(res, rpc, success({ schemaVersion: 'product.journal_notebooks.v1', rows: [{ id: notebookId, name: 'Research' }], asOfUtc: observed })); return;
      case 'listJournalEntries': {
        const second = args.query.cursor === 'page-two';
        tool(res, rpc, success({ schemaVersion: 'product.journal_entries.v1', rows: [{ ...entry, id: second ? otherEntryId : entryId, version: mode === 'updated' ? 2 : 1 }], hasMore: mode === 'cursor-cycle' || !second, nextCursor: second && mode !== 'cursor-cycle' ? null : 'page-two', asOfUtc: observed })); return;
      }
      case 'getTradingAccountResource': tool(res, rpc, success({ schemaVersion: 'canonical_orders.v1', accountId, rows: [{ id: otherEntryId, instrumentId: notebookId, externalOrderId: 'venue-order', side: 'sell', requestedQuantity: orders[1].quantity, limitPrice: orders[1].limitPrice, status: mode === 'readback-pending-no-venue' ? 'pending' : 'filled', ...(mode === 'readback-pending-no-venue' ? { externalOrderId: '' } : {}) }], hasMore: false, nextCursor: null })); return;
      case 'submitManualFuturesLimitOrder':
        if (!args.confirmed) {
          if (mode === 'orders-plan') { tool(res, rpc, { error: 'operation_not_available', operationId: args.operationId }); return; }
          tool(res, rpc, { schemaVersion: 'flusso.mcp_confirmation.v1', confirmationRequired: true, confirmationToken: 'synthetic-order-token', expiresAtUtc: '2026-10-12T02:05:30Z', operation: { operationId: args.operationId }, request: { method: mode === 'preview-method' ? 'DELETE' : 'POST', path: `/api/v1/me/trading-accounts/${accountId}/manual-orders`, query: null, headers: { 'Idempotency-Key': mode === 'preview-key' ? 'another-key' : args.headers['Idempotency-Key'] }, body: mode === 'preview-body' ? { ...args.body, orders: [] } : args.body }, effect: { liveTradingRequested: mode !== 'preview-effect', destructive: true } }); return;
        }
        if (mode === 'orders-lost') { req.socket.destroy(); return; }
        if (mode === 'orders-refused') { tool(res, rpc, { operationId: args.operationId, ok: false, status: 403, outcome: 'failed', result: { schemaVersion: 'product.error.v1', error: { code: 'live_execution_not_included', message: 'The current Flusso plan does not include live execution.' } } }); return; }
        if (mode === 'orders-foreign') { tool(res, rpc, success({ schemaVersion: 'product.manual_order_batch.v1', accountId: notebookId, operationType: 'manual_trade_requested', idempotencyKey: args.headers['Idempotency-Key'], orders: args.body.orders.map((order) => line(order)), asOfUtc: observed })); return; }
        tool(res, rpc, { operationId: args.operationId, ok: mode !== 'orders-unknown-line', status: mode === 'orders-unknown-line' ? 503 : 200, outcome: 'succeeded', idempotencyKey: args.headers['Idempotency-Key'], result: { schemaVersion: 'product.manual_order_batch.v1', accountId, operationType: 'manual_trade_requested', idempotencyKey: args.headers['Idempotency-Key'], orders: args.body.orders.map((order, index) => line(order, mode === 'orders-mixed' && index === 1 ? 'blocked' : mode === 'orders-unknown-line' && index === 1 ? 'unknown' : 'submitted')), asOfUtc: observed } }); return;
      case 'updateJournalEntry':
        if (!args.confirmed) { tool(res, rpc, { schemaVersion: 'flusso.mcp_confirmation.v1', confirmationRequired: true, confirmationToken: 'synthetic-journal-token', expiresAtUtc: '2026-10-12T02:05:30Z', operation: { operationId: args.operationId }, request: { body: args.body } }); return; }
        if (mode === 'journal-conflict') { tool(res, rpc, { operationId: args.operationId, ok: false, status: 409, outcome: 'failed', result: { schemaVersion: 'product.error.v1', error: { code: 'journal_entry_version_conflict', message: 'The entry changed.' } } }); return; }
        tool(res, rpc, success({ schemaVersion: 'product.journal_entry.v1', telegramStatus: 'none', asOfUtc: observed, entry: { ...args.body, id: args.pathParameters.entryId, version: args.body.version + 1, createdAtUtc: observed, updatedAtUtc: observed, telegramStatus: 'none' } })); return;
      default: response(res, {}, 500);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  local = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { requests = []; mode = ''; refreshCount = 0; authorizationUrl = null; releaseToken = null; tokenStarted = null; });

function client({ expiresAt = now + 3600000, connected = true, callbackIssuer = origin, callbackState = null, afterResponse = async () => {}, clock = () => now } = {}) {
  const values = new Map();
  if (connected) values.set(`flusso.listener.oauth:${origin}`, JSON.stringify({ clientId: 'synthetic-local-client', tokenEndpoint: `${origin}/oauth/token`, accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', expiresAt, scopes: ['mcp:read', 'mcp:write', 'offline_access'] }));
  const vault = { get: async (name) => values.get(name) ?? null, set: async (name, value) => { values.set(name, value); }, delete: async (name) => { values.delete(name); } };
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, origin, 'Credentials never leave the configured HTTPS origin');
    const result = await fetch(`${local}${new URL(url).pathname}`, options);
    await afterResponse(url, options);
    return result;
  };
  const cloud = createCloudClient({ origin, vault, fetchImpl, clock });
  const browser = {
    openBrowser: async (url) => { authorizationUrl = new URL(url); },
    listenCallback: async ({ state, timeoutMs }) => {
      assert.equal(timeoutMs, 300000);
      return { redirectUri: 'http://127.0.0.1:59123/oauth/callback', waitForCode: Promise.resolve({ code: 'synthetic-authorization-code', state: callbackState ?? state, iss: callbackIssuer }), close: async () => {} };
    },
  };
  return { cloud, values, browser };
}

test('browser authorization binds PKCE, state, issuer and listener client kind without exposing tokens', async () => {
  const { cloud, browser } = client({ connected: false });
  const status = await cloud.beginConnect(browser);
  const registration = requests.find((request) => request.path === '/oauth/register');
  assert.equal(registration.body.client_kind, 'listener');
  assert.equal(registration.body.token_endpoint_auth_method, 'none');
  assert.equal(authorizationUrl.searchParams.get('resource'), `${origin}/mcp`);
  assert.equal(authorizationUrl.searchParams.get('scope'), 'mcp:read mcp:write offline_access');
  assert.equal(authorizationUrl.searchParams.has('connection_lifetime'), false, 'Only authenticated browser consent chooses lifetime');
  const exchange = requests.find((request) => request.path === '/oauth/token');
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), authorizationUrl.searchParams.get('code_challenge'));
  assert.equal(status.connected, true);
  assert.equal(status.connectionId, notebookId);
  assert.equal(JSON.stringify(status).includes('synthetic-access-token'), false);
  assert.equal(JSON.stringify(status).includes('synthetic-rotated-refresh-token'), false);
});

test('incorrect state or issuer cannot exchange a browser code', async () => {
  for (const options of [{ callbackIssuer: 'https://evil.test' }, { callbackState: 'wrong-state' }]) {
    requests = [];
    const { cloud, browser } = client({ connected: false, ...options });
    await assert.rejects(cloud.beginConnect(browser), { code: 'oauth_callback_invalid' });
    assert.equal(requests.some((request) => request.path === '/oauth/token'), false);
  }
});

test('discovery cannot redirect registration or credentials to another origin', async () => {
  mode = 'foreign-endpoint';
  const { cloud, browser } = client({ connected: false });
  await assert.rejects(cloud.beginConnect(browser), { code: 'oauth_metadata_invalid' });
  assert.equal(requests.length, 1);
});

test('an older server cannot silently register an ordinary MCP client as a listener', async () => {
  mode = 'ordinary-client';
  const { cloud, browser } = client({ connected: false });
  await assert.rejects(cloud.beginConnect(browser), { code: 'oauth_registration_failed' });
  assert.equal(requests.some((request) => request.path === '/oauth/token'), false);
});

test('listener tokens require an explicit revocable connection identity and lifetime', async () => {
  mode = 'ordinary-token';
  const { cloud, browser } = client({ connected: false });
  await assert.rejects(cloud.beginConnect(browser), { code: 'oauth_token_invalid' });
  assert.equal((await cloud.status()).connected, false);
});

test('account display profile projects only name/email, caches concurrent reads, and keeps status network-free', async () => {
  let time = now;
  const { cloud } = client({ clock: () => time });
  assert.equal((await cloud.status()).profile, null); assert.equal(requests.length, 0);
  const values = await Promise.all([cloud.profile(), cloud.profile()]);
  assert.deepEqual(values[0], { displayName: 'Research Owner', email: 'owner@example.test' });
  assert.equal(requests.filter(request => request.body?.params?.arguments?.operationId === 'getProfile').length, 1);
  values[0].displayName = 'Consumer mutation';
  assert.equal((await cloud.status()).profile.displayName, 'Research Owner');
  const count = requests.length; await cloud.profile(); await cloud.status(); assert.equal(requests.length, count);
  time += 120001; assert.equal((await cloud.status()).profile, null); assert.equal(requests.length, count);
  await cloud.profile(); assert.equal(requests.filter(request => request.body?.params?.arguments?.operationId === 'getProfile').length, 2);
  await cloud.disconnect(); assert.equal((await cloud.status()).profile, null);
  await assert.rejects(cloud.profile(), { code: 'not_connected' });
});

test('missing display name stays null and malformed account labels cannot enter the profile cache', async () => {
  mode = 'profile-blank'; const blank = client();
  assert.deepEqual(await blank.cloud.profile(), { displayName: null, email: 'owner@example.test' });
  mode = 'profile-invalid'; const malformed = client();
  await assert.rejects(malformed.cloud.profile(), { code: 'profile_response_invalid' });
  assert.equal((await malformed.cloud.status()).profile, null);
});

test('an authorization denial clears a previously cached account display profile', async () => {
  const { cloud } = client(); await cloud.profile();
  assert.equal((await cloud.status()).profile.displayName, 'Research Owner');
  mode = 'mcp-denied'; await assert.rejects(cloud.capabilities(), { code: 'connection_denied' });
  assert.equal((await cloud.status()).profile, null);
});

test('old profile responses cannot populate the cache after disconnect or reconnect', async () => {
  for (const reconnect of [false, true]) {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const delayed = new Promise(resolve => { release = resolve; });
    const { cloud, browser } = client({ afterResponse: async (url, options) => {
      if (new URL(url).pathname === '/mcp' && JSON.parse(options.body).params.arguments.operationId === 'getProfile') { started(); await delayed; }
    } });
    const rejected = assert.rejects(cloud.profile(), { code: 'connection_changed' });
    await ready; await cloud.disconnect(); if (reconnect) await cloud.beginConnect(browser);
    release(); await rejected;
    assert.equal((await cloud.status()).profile, null);
    assert.equal((await cloud.status()).connected, reconnect);
  }
});

test('trading accounts project only identity and labels from the owned account read', async () => {
  const { cloud } = client();
  assert.deepEqual(await cloud.listAccounts(), [{ id: accountId, displayName: 'Research account', publicId: 'ACCOUNT001' }]);
  assert.equal(requests.every((request) => request.body?.params?.name !== 'act_in_flusso'), true);
});

test('concurrent reads rotate one refresh token and immediately forget a revoked connection', async () => {
  const { cloud, values } = client({ expiresAt: now - 1 });
  await Promise.all([cloud.capabilities(), cloud.capabilities()]);
  assert.equal(refreshCount, 1);
  assert.match([...values.values()][0], /synthetic-rotated-refresh-token/);
  const revoked = client({ expiresAt: now - 1 }); mode = 'revoked';
  await assert.rejects(revoked.cloud.capabilities(), { code: 'connection_revoked' });
  assert.equal((await revoked.cloud.status()).connected, false);
});

test('a delayed refresh cannot restore credentials after Disconnect', async () => {
  const { cloud } = client({ expiresAt: now - 1 }); mode = 'delayed-refresh';
  const started = new Promise((resolve) => { tokenStarted = resolve; });
  const pending = cloud.capabilities();
  const rejected = assert.rejects(pending, { code: 'connection_changed' });
  await started;
  await cloud.disconnect();
  releaseToken();
  await rejected;
  assert.equal((await cloud.status()).connected, false);
  assert.equal(requests.some((request) => request.path === '/mcp'), false);
});

test('a final Journal response from an old connection is discarded after disconnect or reconnect', async () => {
  for (const reconnect of [false, true]) {
    let release, started;
    const ready = new Promise((resolve) => { started = resolve; });
    const delayed = new Promise((resolve) => { release = resolve; });
    const { cloud, browser } = client({ afterResponse: async (url, options) => {
      if (new URL(url).pathname !== '/mcp') return;
      const args = JSON.parse(options.body).params.arguments;
      if (args.operationId === 'listJournalEntries' && args.query.cursor === 'page-two') { started(); await delayed; }
    } });
    const pending = cloud.readJournal();
    const rejected = assert.rejects(pending, { code: 'connection_changed' });
    await ready; await cloud.disconnect();
    if (reconnect) await cloud.beginConnect(browser);
    release(); await rejected;
    assert.equal((await cloud.status()).connected, reconnect);
  }
});

test('Journal full pagination preserves later edits to old entries', async () => {
  const { cloud } = client();
  const first = await cloud.readJournal({ notebookIds: [notebookId] });
  assert.equal(first.complete, true); assert.equal(first.entries.length, 2); assert.equal(first.entries[1].version, 1);
  mode = 'updated';
  const second = await cloud.readJournal({ notebookIds: [notebookId] });
  assert.equal(second.entries[1].version, 2);
  assert.equal(requests.filter((request) => request.body?.params?.arguments?.operationId === 'listJournalEntries').length, 4);
  assert.equal(requests.filter((request) => request.body?.params?.arguments?.operationId === 'listJournalEntries').every((request) => request.body.params.arguments.query.notebookId === notebookId), true, 'The server narrows notebook scans before pagination');
});

test('repeating Journal cursors fail closed rather than looping or presenting a partial scan as complete', async () => {
  mode = 'cursor-cycle';
  await assert.rejects(client().cloud.readJournal(), { code: 'journal_response_invalid' });
});

test('a ticket is previewed and confirmed as one exact order list with the original key', async () => {
  const { cloud } = client();
  const result = await cloud.submitOrders({ accountId, orders, idempotencyKey: key, reference: 'ticket kaia-1' });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.lines.map((row) => [row.instrumentId, row.status]), [['gate:KAIA_USDT', 'submitted'], ['bybit:KAIAUSDT', 'submitted']]);
  const calls = requests.filter((request) => request.body?.params?.arguments?.operationId === 'submitManualFuturesLimitOrder').map((request) => request.body.params.arguments);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].confirmed, undefined); assert.equal(calls[1].confirmed, true);
  assert.equal(calls[1].confirmationToken, 'synthetic-order-token');
  for (const call of calls) {
    assert.equal(call.headers['Idempotency-Key'], key);
    assert.equal(call.body.schemaVersion, 'product.manual_order_request.v3');
    assert.deepEqual(call.body.orders, orders);
    assert.equal(call.body.confirmation.accountId, accountId);
    assert.equal(call.body.confirmation.operationType, 'manual_trade_requested');
    assert.match(call.body.confirmation.expectedEffect, /2 limit orders from ticket kaia-1/);
  }
});

test('each order keeps its own result; one refused leg makes the ticket partial', async () => {
  mode = 'orders-mixed';
  const result = await client().cloud.submitOrders({ accountId, orders, idempotencyKey: key });
  assert.equal(result.status, 'partial');
  assert.equal(result.lines[1].riskCode, 'condition_slippage_exceeded');
  assert.match(result.lines[1].message, /4%/);
});

test('plan, scope and product refusals are definitive and send nothing further', async () => {
  for (const refusal of ['orders-unavailable', 'orders-plan', 'orders-refused']) {
    mode = refusal; requests = [];
    const result = await client().cloud.submitOrders({ accountId, orders, idempotencyKey: key });
    assert.equal(result.status, 'blocked'); assert.ok(result.message);
    assert.equal(requests.filter((request) => request.body?.params?.arguments?.confirmed).length, refusal === 'orders-refused' ? 1 : 0);
  }
});

test('a lost, foreign or partly unknown result remains unknown for read-only recovery', async () => {
  for (const uncertain of ['orders-lost', 'orders-foreign', 'orders-unknown-line']) {
    mode = uncertain;
    assert.equal((await client().cloud.submitOrders({ accountId, orders, idempotencyKey: key })).status, 'unknown');
  }
  assert.equal(ticketStatus([{ status: 'submitted' }, { status: 'not_sent' }]), 'unknown');
  assert.equal(ticketStatus([{ status: 'blocked' }, { status: 'blocked' }]), 'blocked');
});

test('an old order response is discarded after disconnect', async () => {
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const delayed = new Promise((resolve) => { release = resolve; });
  const { cloud } = client({ afterResponse: async (url, options) => {
    if (new URL(url).pathname === '/mcp' && JSON.parse(options.body).params.arguments.confirmed) { started(); await delayed; }
  } });
  const pending = cloud.submitOrders({ accountId, orders, idempotencyKey: key });
  await ready; await cloud.disconnect(); release();
  assert.equal((await pending).status, 'unknown', 'A dispatched order is never reported as refused');
});


test('preview method, body, retry identity and financial effect must match before any confirmation', async () => {
  for (const invalid of ['preview-method', 'preview-body', 'preview-key', 'preview-effect']) {
    mode = invalid; requests = [];
    assert.equal((await client().cloud.submitOrders({ accountId, orders, idempotencyKey: key })).status, 'blocked');
    assert.equal(requests.some(request => request.body?.params?.arguments?.confirmed), false);
  }
});

test('turning execution off after preview prevents confirmation and is a definitive unsent result', async () => {
  let enabled = true;
  const { cloud } = client({ afterResponse: async (url, options) => {
    if (new URL(url).pathname === '/mcp') {
      const args = JSON.parse(options.body).params.arguments;
      if (args.operationId === 'submitManualFuturesLimitOrder' && !args.confirmed) enabled = false;
    }
  } });
  const result = await cloud.submitOrders({ accountId, orders, idempotencyKey: key }, { canDispatch: async () => enabled });
  assert.equal(result.status, 'blocked');
  assert.equal(requests.some(request => request.body?.params?.arguments?.confirmed), false);
});

test('caller edits cannot change the frozen previewed orders', async () => {
  const mutable = structuredClone(orders);
  const { cloud } = client({ afterResponse: async (url, options) => {
    if (new URL(url).pathname === '/mcp') {
      const args = JSON.parse(options.body).params.arguments;
      if (args.operationId === 'submitManualFuturesLimitOrder' && !args.confirmed) mutable[0].quantity *= 2;
    }
  } });
  assert.equal((await cloud.submitOrders({ accountId, orders: mutable, idempotencyKey: key })).status, 'submitted');
  const confirms = requests.filter(request => request.body?.params?.arguments?.confirmed);
  assert.deepEqual(confirms[0].body.params.arguments.body.orders, orders);
});

test('unknown recovery reads exact canonical IDs and never sends a replacement POST', async () => {
  const lines = orders.map(order => line(order));
  lines[1] = { ...lines[1], status: 'unknown', submitted: false, riskAccepted: true, orderId: otherEntryId, canonicalInstrumentId: notebookId };
  const attempt = { accountId, orders, idempotencyKey: key, receipt: { status: 'unknown', lines, message: null } };
  const { cloud } = client();
  const result = await cloud.reconcileOrders(attempt);
  assert.equal(result.status, 'submitted');
  assert.match(result.lines[1].message, /Submission is not a fill/);
  assert.equal(requests.some(request => request.body?.params?.name === 'act_in_flusso'), false);
  mode = 'readback-pending-no-venue';
  assert.equal(await cloud.reconcileOrders(attempt), null);
  assert.equal(await cloud.reconcileOrders({ ...attempt, receipt: null }), null);
  assert.equal(await cloud.reconcileOrders({ ...attempt, receipt: { ...attempt.receipt, lines: [lines[0], { ...lines[1], orderId: null }] } }), null);
});

test('a listener result is written to a cloud entry as one previewed and confirmed update', async () => {
  const { cloud } = client();
  const updated = await cloud.updateJournalEntry({ entry: { ...entry, title: 'KAIA hedge', source: 'agent', version: 4 }, body: 'Ticket\n\n## Listener result\n\n**Placed**', status: 'reviewed', idempotencyKey: 'listener-note-synthetic-key' });
  assert.equal(updated.version, 5); assert.equal(updated.status, 'reviewed');
  const calls = requests.filter((request) => request.body?.params?.arguments?.operationId === 'updateJournalEntry').map((request) => request.body.params.arguments);
  assert.equal(calls.length, 2); assert.equal(calls[1].confirmed, true); assert.equal(calls[1].confirmationToken, 'synthetic-journal-token');
  assert.equal(calls[1].body.version, 4); assert.equal('signal' in calls[1].body, false, 'The research snapshot is kept by omitting it');
  mode = 'journal-conflict';
  await assert.rejects(client().cloud.updateJournalEntry({ entry: { ...entry, title: 'KAIA hedge', version: 4 }, body: 'x', status: 'reviewed', idempotencyKey: 'listener-note-synthetic-key' }), { code: 'journal_update_conflict' });
});
