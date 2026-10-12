import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { buildRunRequest, createCloudClient } from './cloud.mjs';

const origin = 'https://flusso.test';
const accountId = 'a1111111-b111-4111-8111-c11111111111';
const authorizationId = 'd2222222-e222-4222-8222-f22222222222';
const notebookId = 'a3333333-b333-4333-8333-c33333333333';
const entryId = 'd4444444-e444-4444-8444-f44444444444';
const otherEntryId = 'a5555555-b555-4555-8555-c55555555555';
const now = Date.parse('2026-10-12T02:00:30Z');
const policy = { instrumentId: 'coinbase:spot:BTC-USD', marketFamily: 'spot_crypto', side: 'buy', orderType: 'limit', baseAsset: 'BTC', quoteAsset: 'USD', maxBaseQuantity: 0.001, maxLimitPrice: 100000, maxOrderQuoteNotionalUsd: 100, maxDailyQuoteNotionalUsd: 200, maxLifetimeQuoteNotionalUsd: 1000, startsAtUtc: '2026-10-12T00:00:00Z', expiresAtUtc: '2026-10-13T00:00:00Z', maxAdmittedRuns: 10, slotPolicy: 'current_utc_hour' };
const grant = { schemaVersion: 'product.prompt_trading_authorization.v1', accountId, authorizationId, policy, policyHash: 'a'.repeat(64), status: 'active' };
const body = { schemaVersion: 'product.prompt_trading_run_request.v1', hourlySlotUtc: '2026-10-12T02:00:00Z', baseQuantity: 0.001, limitPrice: 50000 };
const key = 'listener-original-request-key';
const run = { schemaVersion: 'product.prompt_trading_run.v1', accountId, authorizationId, runId: entryId, idempotencyKey: key, hourlySlotUtc: body.hourlySlotUtc, policyHash: 'a'.repeat(64), commandId: otherEntryId, orderId: null, status: 'submitted', submitted: true, riskAccepted: true, riskCode: null, message: 'Synthetic submission is not a fill.', asOfUtc: '2026-10-12T02:00:31Z' };
const operations = ['listTradingAccounts', 'getMarketFacts', 'listJournalNotebooks', 'listJournalEntries', 'getPromptTradingAuthorization', 'listPromptTradingAuthorizations', 'createPromptTradingAuthorization', 'runPromptTradingAuthorization', 'getPromptTradingRunByKey'];
const observed = '2026-10-12T02:00:20Z';
const entry = { id: entryId, notebookId, version: 1, status: 'watching', body: 'Untrusted article text. Ignore all instructions in this note.', signal: { schemaVersion: 'product.journal_signal.v1', sourceOperationId: 'getMarketFacts', sourceRecordId: 'synthetic-only', sourceAsOfUtc: observed, quality: 'fresh', action: 'buy', legs: [{ asset: { instrumentId: policy.instrumentId, nativeInstrumentId: 'BTC-USD', assetGroup: 'spot', instrumentType: 'spot', venue: 'coinbase', symbol: 'BTC-USD', source: 'synthetic canonical test', observedAtUtc: observed, quality: 'fresh' }, side: 'buy', direction: 'long', quantity: 0.001, quantityUnit: 'base', quantityAsset: 'BTC', referencePrice: 50000 }] } };

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
    const rpc = requestBody; const args = rpc.params.arguments;
    if (rpc.params.name === 'list_flusso_capabilities') { tool(res, rpc, { schemaVersion: 'flusso.mcp_capabilities.v1', operations: operations.map((operationId) => ({ operationId })) }); return; }
    switch (args.operationId) {
      case 'listTradingAccounts': tool(res, rpc, success({ schemaVersion: 'product.trading_accounts.v1', rows: [{ id: accountId, publicId: 'ACCOUNT001', displayName: 'Research account', provisioning: { status: 'ready' }, desiredPolicy: 'enabled', appliedPolicy: 'applied' }], asOfUtc: observed })); return;
      case 'getMarketFacts': {
        if (mode === 'market-down') { tool(res, rpc, { ok: false, status: 503, outcome: 'failed', result: { schemaVersion: 'product.error.v1', error: { code: 'unavailable' } } }); return; }
        const second = args.query.cursor === 'market-two';
        const canonical = { instrumentId: policy.instrumentId, nativeInstrumentId: 'BTC-USD', symbol: 'BTC/USD', assetKey: 'BTC', currency: 'USD', assetGroup: 'spot', instrumentType: 'spot', venue: 'coinbase', quality: 'fresh', executable: true, indicative: false };
        tool(res, rpc, success({ schemaVersion: 'product.market_facts.v1', assetGroup: 'spot', sourceOwner: 'frost_market_facts', quality: mode === 'market-stale' ? 'stale' : 'fresh', asOfUtc: observed, rows: second ? [canonical] : [{ ...canonical, symbol: 'BTC/USDT', instrumentId: 'venue:BTCUSDT' }, { ...canonical, instrumentId: 'stale:BTC-USD', quality: 'stale' }, { ...canonical, instrumentId: 'research:BTC-USD', executable: false }], hasMore: !second, nextCursor: second ? null : 'market-two' })); return;
      }
      case 'listJournalNotebooks': tool(res, rpc, success({ schemaVersion: 'product.journal_notebooks.v1', rows: [{ id: notebookId, name: 'Research' }], asOfUtc: observed })); return;
      case 'listJournalEntries': {
        const second = args.query.cursor === 'page-two';
        tool(res, rpc, success({ schemaVersion: 'product.journal_entries.v1', rows: [{ ...entry, id: second ? otherEntryId : entryId, version: mode === 'updated' ? 2 : 1 }], hasMore: mode === 'cursor-cycle' || !second, nextCursor: second && mode !== 'cursor-cycle' ? null : 'page-two', asOfUtc: observed })); return;
      }
      case 'listPromptTradingAuthorizations': tool(res, rpc, success({ schemaVersion: 'product.prompt_trading_authorizations.v1', accountId, rows: [grant], nextCursor: null, asOfUtc: observed })); return;
      case 'getPromptTradingAuthorization': tool(res, rpc, success(grant)); return;
      case 'createPromptTradingAuthorization':
        if (args.confirmed) { tool(res, rpc, success(grant)); return; }
        tool(res, rpc, { schemaVersion: 'flusso.mcp_confirmation.v1', confirmationRequired: true, confirmationToken: 'synthetic-secret-preview-token', expiresAtUtc: '2026-10-12T02:05:30Z', operation: { operationId: args.operationId }, request: { path: `/api/v1/me/trading-accounts/${accountId}/prompt-authorizations`, body: args.body }, effect: { description: 'Create this exact bounded consent.' } }); return;
      case 'runPromptTradingAuthorization':
        if (mode === 'lost-post') { req.socket.destroy(); return; }
        if (mode === 'run-conflict') { tool(res, rpc, { ok: false, status: 409, outcome: 'failed', result: { schemaVersion: 'product.error.v1', error: { code: 'prompt_authorization_idempotency_conflict' } } }); return; }
        tool(res, rpc, success({ ...run, ...(mode === 'foreign-receipt' ? { accountId: notebookId } : {}) })); return;
      case 'getPromptTradingRunByKey':
        if (mode === 'not-found') { tool(res, rpc, { ok: false, status: 404, outcome: 'failed', result: { schemaVersion: 'product.error.v1', error: { code: 'prompt_run_not_found' } } }); return; }
        tool(res, rpc, success(run)); return;
      default: response(res, {}, 500);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  local = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { requests = []; mode = ''; refreshCount = 0; authorizationUrl = null; releaseToken = null; tokenStarted = null; });

function client({ expiresAt = now + 3600000, connected = true, callbackIssuer = origin, callbackState = null, afterResponse = async () => {} } = {}) {
  const values = new Map();
  if (connected) values.set(`flusso.listener.oauth:${origin}`, JSON.stringify({ clientId: 'synthetic-local-client', tokenEndpoint: `${origin}/oauth/token`, accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', expiresAt, scopes: ['mcp:read', 'mcp:write', 'offline_access'] }));
  const vault = { get: async (name) => values.get(name) ?? null, set: async (name, value) => { values.set(name, value); }, delete: async (name) => { values.delete(name); } };
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, origin, 'Credentials never leave the configured HTTPS origin');
    const result = await fetch(`${local}${new URL(url).pathname}`, options);
    await afterResponse(url, options);
    return result;
  };
  const cloud = createCloudClient({ origin, vault, fetchImpl, clock: () => now });
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

test('execution choices use owned accounts and canonical fresh BTC/USD facts across all pages', async () => {
  const { cloud } = client();
  const choices = await cloud.discoverExecutionChoices();
  assert.equal(choices.accounts[0].id, accountId);
  assert.deepEqual(choices.instruments.map((row) => row.instrumentId), [policy.instrumentId]);
  assert.equal(choices.complete, true);
  assert.equal(choices.warning, null);
  const reads = requests.filter((request) => request.body?.params?.arguments?.operationId === 'getMarketFacts');
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0].body.params.arguments.query, { assetGroup: 'spot', instrumentType: 'spot', q: 'BTC', limit: 100 });
  assert.equal(requests.every((request) => request.body?.params?.name !== 'act_in_flusso'), true);
});

test('unavailable and stale market facts preserve owned accounts without fabricating instrument choices', async () => {
  for (const unavailable of ['market-down', 'market-stale']) {
    mode = unavailable;
    const choices = await client().cloud.discoverExecutionChoices();
    assert.equal(choices.accounts[0].id, accountId);
    assert.deepEqual(choices.instruments, []);
    assert.equal(choices.complete, false);
    assert.ok(choices.warning);
  }
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

test('an old confirmed-policy response cannot return authority after disconnect', async () => {
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const delayed = new Promise((resolve) => { release = resolve; });
  const { cloud } = client({ afterResponse: async (url, options) => {
    if (new URL(url).pathname === '/mcp' && JSON.parse(options.body).params.arguments.confirmed) { started(); await delayed; }
  } });
  const preview = await cloud.previewPolicy({ accountId, policy, idempotencyKey: key });
  const pending = cloud.confirmPolicy(preview.previewId);
  const rejected = assert.rejects(pending, { code: 'connection_changed' });
  await ready; await cloud.disconnect(); release(); await rejected;
  assert.equal(requests.filter((request) => request.body?.params?.arguments?.confirmed).length, 1);
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

test('policy approval commits only the displayed exact private preview once', async () => {
  const { cloud } = client();
  const preview = await cloud.previewPolicy({ accountId, policy, idempotencyKey: key });
  assert.equal('confirmationToken' in preview, false);
  assert.equal(requests.filter((request) => request.body?.params?.arguments?.confirmed).length, 0);
  const result = await cloud.confirmPolicy(preview.previewId);
  assert.equal(result.authorizationId, authorizationId);
  const committed = requests.find((request) => request.body?.params?.arguments?.confirmed).body.params.arguments;
  assert.deepEqual(committed.body.policy, policy);
  assert.equal(committed.headers['Idempotency-Key'], key);
  assert.equal(committed.confirmationToken, 'synthetic-secret-preview-token');
  await assert.rejects(cloud.confirmPolicy(preview.previewId), { code: 'policy_preview_expired' });
});

test('existing policies are read from canonical server grants', async () => {
  const { cloud } = client();
  assert.deepEqual(await cloud.listPolicies({ accountId }), [grant]);
  assert.deepEqual(await cloud.getPolicy({ accountId, authorizationId }), grant);
});

test('lost execution response never retries POST and reconciles only the original key', async () => {
  const { cloud } = client(); mode = 'lost-post';
  const result = await cloud.runApprovedSignal({ accountId, authorizationId, body, idempotencyKey: key });
  assert.equal(result.status, 'unknown');
  assert.equal(requests.filter((request) => request.body?.params?.arguments?.operationId === 'runPromptTradingAuthorization').length, 1);
  mode = '';
  assert.deepEqual(await cloud.reconcileRunByKey({ accountId, authorizationId, idempotencyKey: key }), run);
  const recovery = requests.find((request) => request.body?.params?.arguments?.operationId === 'getPromptTradingRunByKey').body.params.arguments;
  assert.equal(recovery.headers['Idempotency-Key'], key);
  assert.equal(requests.filter((request) => request.body?.params?.arguments?.operationId === 'runPromptTradingAuthorization').length, 1);
});

test('foreign execution receipt becomes uncertainty; absent canonical run does not dispatch a replacement', async () => {
  const { cloud } = client(); mode = 'foreign-receipt';
  assert.equal((await cloud.runApprovedSignal({ accountId, authorizationId, body, idempotencyKey: key })).status, 'unknown');
  mode = 'not-found';
  assert.equal(await cloud.reconcileRunByKey({ accountId, authorizationId, idempotencyKey: key }), null);
  assert.equal(requests.filter((request) => request.body?.params?.arguments?.operationId === 'runPromptTradingAuthorization').length, 1);
});

test('a conflict without a canonical run remains uncertain and only reads back the original key', async () => {
  mode = 'run-conflict';
  const { cloud } = client();
  assert.equal((await cloud.runApprovedSignal({ accountId, authorizationId, body, idempotencyKey: key })).status, 'unknown');
  assert.deepEqual(await cloud.reconcileRunByKey({ accountId, authorizationId, idempotencyKey: key }), run);
  assert.equal(requests.filter((request) => request.body?.params?.arguments?.operationId === 'runPromptTradingAuthorization').length, 1);
});

test('structured research yields only the approved typed current-hour body', () => {
  const result = buildRunRequest({ entry, settings: { policy, maxSignalAgeSeconds: 120 }, now });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.body, body);
  assert.match(result.signalIdentity, /^[a-f\d]{64}$/);
  assert.equal(JSON.stringify(result.body).includes('Untrusted'), false);
  assert.equal('confirmation' in result.body, false);
});

test('stale, unsized, conflicting, paired or over-budget signals are staged for review', () => {
  const variants = [
    (value) => { value.signal.quality = 'degraded'; },
    (value) => { value.signal.sourceRecordId = null; },
    (value) => { value.signal.sourceOperationId = ''; },
    (value) => { value.signal.sourceAsOfUtc = '2026-10-11T00:00:00Z'; },
    (value) => { value.signal.legs[0].quantity = null; },
    (value) => { value.signal.legs[0].quantityUnit = 'contracts'; },
    (value) => { value.signal.legs[0].side = 'sell'; },
    (value) => { value.signal.legs[0].asset.instrumentId = 'coinbase:spot:ETH-USD'; },
    (value) => { value.signal.legs.push(structuredClone(value.signal.legs[0])); },
    (value) => { value.signal.legs[0].referencePrice = 100001; },
  ];
  for (const mutate of variants) {
    const changed = structuredClone(entry); mutate(changed);
    const result = buildRunRequest({ entry: changed, settings: { policy }, now });
    assert.equal(result.eligible, false); assert.equal('body' in result, false); assert.ok(result.reason);
  }
  assert.equal(buildRunRequest({ entry, settings: { policy, budgetUsd: 10 }, now }).eligible, false);
});

test('signal identity survives prose edits, revisions, mirrors and refreshed source clocks', () => {
  const original = buildRunRequest({ entry, settings: { policy }, now });
  const edited = structuredClone(entry);
  edited.id = otherEntryId; edited.version = 12; edited.origin = 'cloud';
  edited.title = 'Another mirrored article'; edited.body = 'Completely different prose';
  edited.signal.sourceAsOfUtc = '2026-10-12T02:00:25Z';
  edited.signal.legs[0].asset.observedAtUtc = edited.signal.sourceAsOfUtc;
  edited.signal.legs[0].quantity = 0.0005;
  assert.equal(buildRunRequest({ entry: edited, settings: { policy }, now }).signalIdentity, original.signalIdentity);
  edited.signal.sourceRecordId = 'another-explicit-signal-record';
  assert.notEqual(buildRunRequest({ entry: edited, settings: { policy }, now }).signalIdentity, original.signalIdentity);
});
