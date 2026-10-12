import { createHash, randomBytes, randomUUID } from 'node:crypto';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 50;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const KEY = /^[!-~]{8,160}$/;
const SCOPES = ['mcp:read', 'mcp:write', 'offline_access'];
const POLICY_KEYS = ['instrumentId', 'marketFamily', 'side', 'orderType', 'baseAsset', 'quoteAsset', 'maxBaseQuantity', 'maxLimitPrice', 'maxOrderQuoteNotionalUsd', 'maxDailyQuoteNotionalUsd', 'maxLifetimeQuoteNotionalUsd', 'startsAtUtc', 'expiresAtUtc', 'maxAdmittedRuns', 'slotPolicy'];
const RUN_KEYS = ['schemaVersion', 'hourlySlotUtc', 'baseQuantity', 'limitPrice'];

export class CloudError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'CloudError'; this.code = code; this.status = status; }
}

function fail(code, message, status) { throw new CloudError(code, message, status); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function sourceIdentity(value, maximum) { return typeof value === 'string' && value.length <= maximum && value.trim().length > 0 && value === value.trim() && !/\p{Cc}/u.test(value); }
function exactKeys(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_identity', 'Use an owned canonical account or authorization identifier.'); return value; }
function retryKey(value) { if (typeof value !== 'string' || !KEY.test(value)) fail('invalid_retry_key', 'One original retry key is required.'); return value; }
function safeEndpoint(value, origin, path) {
  let url;
  try { url = new URL(value); } catch { fail('oauth_metadata_invalid', 'Flusso returned invalid authorization metadata.'); }
  if (url.origin !== origin || url.pathname !== path || url.search || url.hash || url.username || url.password) fail('oauth_metadata_invalid', 'Authorization endpoints must remain on the configured Flusso origin.');
  return url.href;
}

async function readText(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) fail('response_too_large', 'The response exceeded the local client limit.');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('response_too_large', 'The response exceeded the local client limit.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { fail('response_invalid', 'Flusso returned an invalid response.'); }
}

function rpcPayload(text, contentType, requestId) {
  if (!contentType.includes('text/event-stream')) return parseJson(text);
  for (const event of text.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    const candidate = parseJson(data);
    if (candidate.id === requestId) return candidate;
  }
  fail('response_invalid', 'Flusso did not return the requested response.');
}

function policyValid(policy) {
  return exactKeys(policy, POLICY_KEYS)
    && typeof policy.instrumentId === 'string' && /^[a-z0-9][a-z0-9._-]*:(?:spot:)?[^:\s]+$/.test(policy.instrumentId)
    && policy.marketFamily === 'spot_crypto' && policy.side === 'buy' && policy.orderType === 'limit'
    && policy.baseAsset === 'BTC' && policy.quoteAsset === 'USD' && policy.slotPolicy === 'current_utc_hour'
    && ['maxBaseQuantity', 'maxLimitPrice', 'maxOrderQuoteNotionalUsd', 'maxDailyQuoteNotionalUsd', 'maxLifetimeQuoteNotionalUsd'].every((key) => positive(policy[key]))
    && policy.maxDailyQuoteNotionalUsd >= policy.maxOrderQuoteNotionalUsd && policy.maxLifetimeQuoteNotionalUsd >= policy.maxDailyQuoteNotionalUsd
    && Number.isInteger(policy.maxAdmittedRuns) && policy.maxAdmittedRuns > 0 && policy.maxAdmittedRuns <= 2147483647
    && Number.isFinite(Date.parse(policy.startsAtUtc)) && Date.parse(policy.expiresAtUtc) > Date.parse(policy.startsAtUtc);
}

function hour(now) { const date = new Date(now); date.setUTCMinutes(0, 0, 0); return date.toISOString().replace('.000Z', 'Z'); }
function runValid(body) { return exactKeys(body, RUN_KEYS) && body.schemaVersion === 'product.prompt_trading_run_request.v1' && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(body.hourlySlotUtc) && positive(body.baseQuantity) && positive(body.limitPrice); }
function equalId(left, right) { return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase(); }

function assertGrant(grant, accountId, authorizationId = null) {
  if (!object(grant) || grant.schemaVersion !== 'product.prompt_trading_authorization.v1' || !equalId(grant.accountId, accountId)
    || !UUID.test(grant.authorizationId ?? '') || authorizationId !== null && !equalId(grant.authorizationId, authorizationId)
    || !policyValid(grant.policy) || !/^[a-f\d]{64}$/.test(grant.policyHash ?? '')
    || !['active', 'revoked', 'expired', 'session_revoked'].includes(grant.status)) fail('policy_response_invalid', 'The server policy did not match the owned account and supported bounds.');
  return grant;
}

function assertRun(receipt, accountId, authorizationId, key, body = null) {
  if (!object(receipt) || receipt.schemaVersion !== 'product.prompt_trading_run.v1' || !equalId(receipt.accountId, accountId)
    || !equalId(receipt.authorizationId, authorizationId) || receipt.idempotencyKey !== key
    || !UUID.test(receipt.runId ?? '') || !/^[a-f\d]{64}$/.test(receipt.policyHash ?? '')
    || !['planned', 'submitted', 'blocked', 'unknown'].includes(receipt.status)
    || receipt.submitted !== (receipt.status === 'submitted') || typeof receipt.riskAccepted !== 'boolean'
    || receipt.commandId !== null && !UUID.test(receipt.commandId ?? '')
    || receipt.commandId === null && receipt.status !== 'blocked'
    || body !== null && receipt.hourlySlotUtc !== body.hourlySlotUtc
    || !Number.isFinite(Date.parse(receipt.asOfUtc))) fail('run_response_invalid', 'The execution response could not be bound to the original request.');
  return receipt;
}

/** Notes and model output select data only. This helper never creates authority. */
export function buildRunRequest({ entry, settings, now = Date.now() }) {
  const review = (reason) => ({ eligible: false, reason });
  if (!object(entry) || entry.status !== 'watching' || !object(settings) || !policyValid(settings.policy)) return review('Choose an active server-approved policy and a watching signal.');
  const policy = settings.policy;
  if (now < Date.parse(policy.startsAtUtc) || now >= Date.parse(policy.expiresAtUtc)) return review('The approved policy is outside its active window.');
  if (Array.isArray(settings.notebookIds) && settings.notebookIds.length && !settings.notebookIds.includes(entry.notebookId)) return review('This notebook is outside the listener selection.');
  const signal = entry.signal;
  if (!object(signal) || signal.schemaVersion !== 'product.journal_signal.v1' || signal.quality !== 'fresh' || !Array.isArray(signal.legs) || signal.legs.length !== 1) return review('Execution requires one fresh structured signal; prose, degraded observations, and paired signals remain for review.');
  if (!sourceIdentity(signal.sourceOperationId, 160) || !sourceIdentity(signal.sourceRecordId, 256)
    || signal.strategyDefinitionId != null && !sourceIdentity(signal.strategyDefinitionId, 256)) return review('Record a stable source operation and signal record identity before unattended execution. Notes without a source identity remain for review.');
  const leg = signal.legs[0]; const asset = leg?.asset;
  if (!object(asset) || asset.assetGroup !== 'spot' || asset.instrumentType !== 'spot' || asset.instrumentId !== policy.instrumentId
    || asset.quality !== 'fresh' || leg.side !== 'buy' || leg.direction === 'short') return review('This signal is outside the approved spot BTC/USD buy-limit policy.');
  if (signal.action != null && !['buy', 'open', 'open_long'].includes(signal.action)) return review('This signal action needs review.');
  const maximumAge = settings.maxSignalAgeSeconds ?? 120;
  if (!Number.isFinite(maximumAge) || maximumAge < 1 || maximumAge > 900) return review('Choose a freshness limit between 1 and 900 seconds.');
  const clocks = [signal.sourceAsOfUtc, asset.observedAtUtc];
  if (clocks.some((value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) > now || now - Date.parse(value) > maximumAge * 1000)) return review('The source timestamps are missing, future-dated, or outside the selected freshness limit.');
  if (!positive(leg.quantity) || !['base', 'tokens'].includes(leg.quantityUnit) || leg.quantityAsset !== 'BTC' || !positive(leg.referencePrice)) return review('Record an explicit BTC base quantity and reference limit price; missing or ambiguous units require review.');
  const body = { schemaVersion: 'product.prompt_trading_run_request.v1', hourlySlotUtc: hour(now), baseQuantity: leg.quantity, limitPrice: leg.referencePrice };
  const notional = body.baseQuantity * body.limitPrice;
  if (!Number.isFinite(notional) || body.baseQuantity > policy.maxBaseQuantity || body.limitPrice > policy.maxLimitPrice || notional > policy.maxOrderQuoteNotionalUsd) return review('The signal exceeds the approved quantity, price, or order budget.');
  if (settings.budgetUsd != null && (!positive(settings.budgetUsd) || notional > settings.budgetUsd)) return review('The signal exceeds this listener’s selected budget.');
  // The emitted source record is the identity. Editing prose, refreshing a source
  // clock, changing a size, or mirroring a note cannot create another signal.
  const signalIdentity = createHash('sha256').update(JSON.stringify({
    schemaVersion: 'flusso.listener_signal_identity.v1',
    strategyDefinitionId: signal.strategyDefinitionId ?? null,
    sourceOperationId: signal.sourceOperationId, sourceRecordId: signal.sourceRecordId,
    legs: signal.legs.map((item) => ({ instrumentId: item.asset.instrumentId,
      nativeInstrumentId: item.asset.nativeInstrumentId ?? null,
      assetGroup: item.asset.assetGroup, instrumentType: item.asset.instrumentType,
      venue: item.asset.venue, side: item.side, direction: item.direction ?? null })),
  })).digest('hex');
  return { eligible: true, body, signalIdentity };
}

/** The vault stores the complete credential bundle in the operating-system vault. */
export function createCloudClient({ origin = 'https://flusso.stream', vault, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) fail('origin_invalid', 'Cloud connections require an exact HTTPS origin.');
  if (!vault || ['get', 'set', 'delete'].some((method) => typeof vault[method] !== 'function')) throw new TypeError('An operating-system vault adapter is required.');
  const vaultName = `flusso.listener.oauth:${origin}`;
  const previews = new Map();
  let refreshPending = null; let connectionPending = false; let credentialGeneration = 0;
  let vaultWrites = Promise.resolve();
  const requireGeneration = (generation) => { if (generation !== credentialGeneration) fail('connection_changed', 'This connection changed while the request was in progress.'); };
  const bundle = async () => { const value = await vault.get(vaultName); return value ? parseJson(value) : null; };
  const writeVault = (action) => { const next = vaultWrites.catch(() => {}).then(action); vaultWrites = next; return next; };
  const save = (value, generation) => writeVault(async () => {
    if (generation !== credentialGeneration) fail('connection_changed', 'This connection changed while the request was in progress.');
    await vault.set(vaultName, JSON.stringify(value));
  });

  async function request(endpoint, options = {}) {
    let response;
    try { response = await fetchImpl(endpoint, { redirect: 'error', signal: AbortSignal.timeout(20000), ...options }); }
    catch { fail('connection_unavailable', 'The cloud request did not return a definitive response.'); }
    const text = await readText(response);
    return { response, text };
  }

  async function token(endpoint, values, previous = {}, generation = credentialGeneration) {
    const { response, text } = await request(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(values).toString() });
    const result = parseJson(text);
    if (!response.ok) {
      if (result.error === 'invalid_grant' && generation === credentialGeneration) {
        credentialGeneration += 1; previews.clear(); await writeVault(() => vault.delete(vaultName));
      }
      fail(result.error === 'invalid_grant' ? 'connection_revoked' : 'authentication_failed', 'Flusso authorization failed. Reconnect in the browser.', response.status);
    }
    if (typeof result.access_token !== 'string' || result.access_token.length < 1 || result.access_token.length > 16384
      || String(result.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 86400
      || typeof (result.refresh_token ?? previous.refreshToken) !== 'string'
      || !UUID.test(result.connection_id ?? '') || previous.connectionId && result.connection_id !== previous.connectionId
      || !Object.hasOwn(result, 'connection_expires_at') || result.connection_expires_at !== null && (!Number.isFinite(Date.parse(result.connection_expires_at)) || Date.parse(result.connection_expires_at) <= clock())) fail('oauth_token_invalid', 'Flusso returned an invalid or unsupported listener credential response. Update Flusso and reconnect.');
    const scopes = typeof result.scope === 'string' ? result.scope.split(' ').filter(Boolean) : previous.scopes ?? [];
    if (!scopes.includes('mcp:read')) fail('oauth_scope_missing', 'The connection did not grant Journal read access.');
    return { ...previous, accessToken: result.access_token, refreshToken: result.refresh_token ?? previous.refreshToken, expiresAt: clock() + result.expires_in * 1000, scopes, connectionId: result.connection_id, connectionExpiresAt: result.connection_expires_at };
  }

  async function access() {
    const generation = credentialGeneration;
    const current = await bundle();
    if (generation !== credentialGeneration) fail('connection_changed', 'This connection changed while the request was in progress.');
    if (!current?.accessToken || !current?.clientId || !current?.refreshToken) fail('not_connected', 'Connect your Flusso account first.');
    if (current.expiresAt > clock() + 30000) return { ...current, generation };
    if (!refreshPending) refreshPending = (async () => {
      const refreshed = await token(safeEndpoint(current.tokenEndpoint, origin, '/oauth/token'), { grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: current.clientId, resource: `${origin}/mcp` }, current, generation);
      await save(refreshed, generation); return { ...refreshed, generation };
    })().finally(() => { refreshPending = null; });
    return refreshPending;
  }

  async function mcp(name, args) {
    const credentials = await access();
    if (credentials.generation !== credentialGeneration) fail('connection_changed', 'This connection changed while the request was in progress.');
    const requestId = randomUUID();
    const { response, text } = await request(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${credentials.accessToken}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }) });
    requireGeneration(credentials.generation);
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'connection_denied' : 'cloud_unavailable', 'Flusso could not complete this request.', response.status);
    const rpc = rpcPayload(text, response.headers.get('content-type') ?? '', requestId);
    if (rpc.jsonrpc !== '2.0' || rpc.id !== requestId || rpc.error || !object(rpc.result)) fail('mcp_response_invalid', 'Flusso returned an invalid tool response.');
    const result = rpc.result.structuredContent ?? parseJson(rpc.result.content?.find((item) => item.type === 'text')?.text ?? 'null');
    if (!object(result)) fail('mcp_response_invalid', 'Flusso returned an invalid tool payload.');
    return result;
  }

  async function capabilities() {
    const result = await mcp('list_flusso_capabilities', { access: 'all' });
    if (result.schemaVersion !== 'flusso.mcp_capabilities.v1' || !Array.isArray(result.operations)) fail('capabilities_invalid', 'Flusso did not return its current capability catalog.');
    return result;
  }

  async function requireOperations(names) {
    const catalog = await capabilities();
    for (const name of names) if (!catalog.operations.some((op) => op.operationId === name)) fail('operation_unavailable', 'The connected account does not expose a required Journal or execution operation.');
  }

  function unwrap(value) {
    if (value.ok !== true || !object(value.result)) fail('operation_failed', 'Flusso refused this operation.', Number(value.status) || 0);
    return value.result;
  }
  const read = async (operationId, pathParameters, query, headers) => mcp('read_flusso', { operationId, ...(pathParameters ? { pathParameters } : {}), ...(query ? { query } : {}), ...(headers ? { headers } : {}) });

  async function status() {
    const current = await bundle();
    return { connected: Boolean(current?.refreshToken && current?.clientId), scopes: current?.scopes ?? [], expiresAt: current?.expiresAt ?? null, clientId: current?.clientId ?? null, connectionId: current?.connectionId ?? null, connectionExpiresAt: current?.connectionExpiresAt ?? null };
  }

  async function beginConnect({ openBrowser, listenCallback }) {
    if (connectionPending) fail('connection_pending', 'Complete the existing browser connection first.');
    if (typeof openBrowser !== 'function' || typeof listenCallback !== 'function') throw new TypeError('Browser and loopback callback adapters are required.');
    connectionPending = true;
    const generation = ++credentialGeneration;
    let callback;
    try {
      const { response, text } = await request(`${origin}/.well-known/oauth-authorization-server`, { headers: { accept: 'application/json' } });
      const metadata = parseJson(text);
      if (!response.ok || metadata.issuer !== origin || !metadata.code_challenge_methods_supported?.includes('S256') || metadata.authorization_response_iss_parameter_supported !== true) fail('oauth_metadata_invalid', 'Flusso authorization metadata does not support the required protections.');
      const registrationEndpoint = safeEndpoint(metadata.registration_endpoint, origin, '/oauth/register');
      const authorizationEndpoint = safeEndpoint(metadata.authorization_endpoint, origin, '/oauth/authorize');
      const tokenEndpoint = safeEndpoint(metadata.token_endpoint, origin, '/oauth/token');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      callback = await listenCallback({ state, timeoutMs: 300000 });
      const redirect = new URL(callback.redirectUri);
      if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.pathname !== '/oauth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) fail('callback_invalid', 'Authorization must return to an ephemeral loopback callback.');
      const registered = await request(registrationEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_name: 'Flusso Listener', client_kind: 'listener', redirect_uris: [redirect.href], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
      const registration = parseJson(registered.text);
      if (!registered.response.ok || typeof registration.client_id !== 'string' || registration.client_id.length < 1 || registration.client_id.length > 256 || registration.client_kind !== 'listener') fail('oauth_registration_failed', 'The server does not support listener connections yet. Update Flusso before connecting.');
      const authorize = new URL(authorizationEndpoint);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirect.href, resource: `${origin}/mcp`, scope: SCOPES.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
      await openBrowser(authorize.href);
      const answer = await callback.waitForCode;
      if (generation !== credentialGeneration) fail('connection_changed', 'This connection changed while browser authorization was in progress.');
      if (answer?.state !== state || answer?.iss !== origin || answer.error || typeof answer.code !== 'string' || !answer.code || answer.code.length > 4096) fail('oauth_callback_invalid', 'The browser response did not match this connection request.');
      const connected = await token(tokenEndpoint, { grant_type: 'authorization_code', code: answer.code, redirect_uri: redirect.href, client_id: registration.client_id, code_verifier: verifier, resource: `${origin}/mcp` }, { clientId: registration.client_id, tokenEndpoint, scopes: SCOPES }, generation);
      previews.clear(); await save(connected, generation);
      return status();
    } finally { connectionPending = false; await callback?.close?.(); }
  }

  async function disconnect() { credentialGeneration += 1; previews.clear(); await writeVault(() => vault.delete(vaultName)); }

  async function discoverExecutionChoices() {
    await requireOperations(['listTradingAccounts', 'getMarketFacts']);
    // flusso.e9c4b572812f and flusso.ece3ad0dd6fa: reuse owned account and
    // canonical market reads through Flusso. These choices never grant authority.
    const directory = unwrap(await read('listTradingAccounts'));
    if (directory.schemaVersion !== 'product.trading_accounts.v1' || !Array.isArray(directory.rows)
      || directory.rows.length > 1000 || directory.rows.some((row) => !UUID.test(row?.id ?? '')
        || !sourceIdentity(row.displayName, 120) || !sourceIdentity(row.publicId, 100))) fail('account_response_invalid', 'Flusso returned an invalid owned account list.');
    const result = { accounts: directory.rows, instruments: [], marketQuality: 'unavailable', marketAsOfUtc: null, complete: false, warning: null };
    const instruments = new Map(), seen = new Set(); let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await read('getMarketFacts', null, { assetGroup: 'spot', instrumentType: 'spot', q: 'BTC', limit: 100, ...(cursor ? { cursor } : {}) });
      if (response.ok !== true) return { ...result, warning: 'Current market choices are unavailable. No instrument has been substituted; try again when Flusso market facts recover.' };
      const facts = unwrap(response);
      if (facts.schemaVersion !== 'product.market_facts.v1' || facts.assetGroup !== 'spot' || facts.sourceOwner !== 'frost_market_facts'
        || !['fresh', 'stale', 'degraded', 'unavailable'].includes(facts.quality) || !Array.isArray(facts.rows) || facts.rows.length > 100
        || typeof facts.hasMore !== 'boolean' || facts.hasMore !== (typeof facts.nextCursor === 'string' && facts.nextCursor.length > 0)
        || facts.nextCursor != null && (facts.nextCursor.length > 2048 || seen.has(facts.nextCursor))) fail('market_response_invalid', 'Flusso returned an invalid market choice page.');
      result.marketQuality = facts.quality; result.marketAsOfUtc = facts.asOfUtc ?? null;
      if (facts.quality !== 'fresh') return { ...result, warning: 'Current market facts are not fresh. Wait for fresh canonical BTC/USD choices before creating a policy.' };
      for (const row of facts.rows) {
        if (!object(row) || !sourceIdentity(row.instrumentId, 256) || !sourceIdentity(row.venue, 64) || !sourceIdentity(row.symbol, 160)
          || !['fresh', 'stale', 'degraded', 'unavailable'].includes(row.quality)) fail('market_response_invalid', 'Flusso returned an invalid market choice.');
        // Only source-published spot BTC/USD identities are offered. Currency
        // and identity matching do not calculate a financial value or price.
        if (row.assetGroup === 'spot' && row.instrumentType === 'spot' && row.currency === 'USD'
          && /^(?:BTC\/USD|BTC-USD|BTCUSD)$/.test(row.symbol)
          && row.quality === 'fresh' && row.executable === true && row.indicative === false) instruments.set(row.instrumentId, row);
      }
      if (!facts.hasMore) return { ...result, instruments: [...instruments.values()], complete: true, warning: instruments.size ? null : 'Flusso has no fresh supported spot BTC/USD market choices right now.' };
      cursor = facts.nextCursor; seen.add(cursor);
    }
    return { ...result, warning: 'The market selection exceeds the bounded scan. Narrow canonical market facts before creating a policy.' };
  }

  async function readJournal({ notebookIds = [] } = {}) {
    const generation = credentialGeneration;
    if (!Array.isArray(notebookIds) || notebookIds.length > 200 || notebookIds.some((value) => !UUID.test(value))) fail('journal_selection_invalid', 'Select owned notebook identifiers.');
    await requireOperations(['listJournalNotebooks', 'listJournalEntries']);
    requireGeneration(generation);
    const notebooks = unwrap(await read('listJournalNotebooks'));
    requireGeneration(generation);
    if (notebooks.schemaVersion !== 'product.journal_notebooks.v1' || !Array.isArray(notebooks.rows) || notebooks.rows.some((row) => !UUID.test(row?.id ?? ''))) fail('journal_response_invalid', 'Flusso returned an invalid notebook list.');
    if (notebookIds.some((selected) => !notebooks.rows.some((row) => equalId(row.id, selected)))) fail('journal_selection_missing', 'A selected notebook is unavailable in this account.');
    const entries = new Map(); let asOfUtc = notebooks.asOfUtc; let pages = 0;
    const selectedNotebooks = notebooks.rows.filter((row) => !notebookIds.length || notebookIds.some((selected) => equalId(selected, row.id)));
    for (const notebookId of notebookIds.length ? [...new Set(notebookIds)] : [null]) {
      const seen = new Set(); let cursor = null;
      while (true) {
        if (pages++ >= MAX_PAGES) return { notebooks: selectedNotebooks, entries: [...entries.values()], complete: false, asOfUtc, reason: 'The selection exceeds the bounded 50-page Journal scan. Execution stays paused until the selected notebooks can be scanned completely.' };
        const result = unwrap(await read('listJournalEntries', null, { limit: 100, ...(notebookId ? { notebookId } : {}), ...(cursor ? { cursor } : {}) }));
        requireGeneration(generation);
        if (result.schemaVersion !== 'product.journal_entries.v1' || !Array.isArray(result.rows) || result.rows.length > 100 || typeof result.hasMore !== 'boolean'
          || result.hasMore !== (typeof result.nextCursor === 'string' && result.nextCursor.length > 0)
          || result.nextCursor != null && (result.nextCursor.length > 2048 || seen.has(result.nextCursor))) fail('journal_response_invalid', 'Flusso returned an invalid Journal page.');
        for (const row of result.rows) {
          if (!UUID.test(row?.id ?? '') || !UUID.test(row?.notebookId ?? '') || !Number.isInteger(row.version) || row.version < 1
            || notebookId && !equalId(row.notebookId, notebookId)) fail('journal_response_invalid', 'Flusso returned an invalid or unselected Journal entry.');
          const current = entries.get(row.id.toLowerCase());
          if (!current || current.version < row.version) entries.set(row.id.toLowerCase(), row);
        }
        asOfUtc = result.asOfUtc;
        if (!result.hasMore) break;
        cursor = result.nextCursor; seen.add(cursor);
      }
    }
    return { notebooks: selectedNotebooks, entries: [...entries.values()], complete: true, asOfUtc };
  }

  async function listPolicies({ accountId }) {
    id(accountId); await requireOperations(['listPromptTradingAuthorizations']);
    const rows = []; const seen = new Set(); let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = unwrap(await read('listPromptTradingAuthorizations', { id: accountId }, { limit: 100, ...(cursor ? { cursor } : {}) }));
      if (result.schemaVersion !== 'product.prompt_trading_authorizations.v1' || !equalId(result.accountId, accountId) || !Array.isArray(result.rows) || result.rows.length > 100) fail('policy_response_invalid', 'The server returned an invalid owned policy page.');
      rows.push(...result.rows.map((grant) => assertGrant(grant, accountId)));
      if (result.nextCursor === null) return rows;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 2048 || seen.has(result.nextCursor)) fail('policy_response_invalid', 'The policy cursor repeated or was invalid.');
      cursor = result.nextCursor; seen.add(cursor);
    }
    fail('policy_scan_incomplete', 'The policy list exceeds the bounded scan.');
  }

  async function getPolicy({ accountId, authorizationId }) {
    id(accountId); id(authorizationId); await requireOperations(['getPromptTradingAuthorization']);
    return assertGrant(unwrap(await read('getPromptTradingAuthorization', { id: accountId, authorizationId })), accountId, authorizationId);
  }

  async function previewPolicy({ accountId, policy, idempotencyKey, confirmation }) {
    id(accountId); retryKey(idempotencyKey);
    if (!policyValid(policy) || Date.parse(policy.expiresAtUtc) <= clock()) fail('policy_invalid', 'Use future, bounded spot BTC/USD buy-limit policy values.');
    await requireOperations(['createPromptTradingAuthorization']);
    const ownerConfirmation = confirmation ?? { accountId, operationType: 'prompt_trading_authorization_created', expectedEffect: 'Allow this listener to request spot BTC/USD buy-limit orders within these immutable limits.', riskImpact: 'Orders can spend the approved gross USD budgets. Risk and current venue permissions still apply.', rollbackPath: 'Revoke this authorization to stop future admissions; cancel outstanding orders separately.' };
    const args = structuredClone({ operationId: 'createPromptTradingAuthorization', pathParameters: { id: accountId }, headers: { 'Idempotency-Key': idempotencyKey }, body: { schemaVersion: 'product.prompt_trading_authorization_create.v1', policy, confirmation: ownerConfirmation } });
    const preview = await mcp('act_in_flusso', args);
    if (preview.schemaVersion !== 'flusso.mcp_confirmation.v1' || preview.confirmationRequired !== true || typeof preview.confirmationToken !== 'string' || Date.parse(preview.expiresAtUtc) <= clock()
      || preview.operation?.operationId !== args.operationId || preview.request?.path !== `/api/v1/me/trading-accounts/${accountId}/prompt-authorizations`
      || !policyValid(preview.request.body?.policy) || POLICY_KEYS.some((name) => preview.request.body.policy[name] !== policy[name])) fail('policy_preview_invalid', 'The server preview did not match the requested policy.');
    for (const [key, pending] of previews) if (pending.expiresAt <= clock()) previews.delete(key);
    if (previews.size >= 20) fail('policy_preview_limit', 'Complete or wait for an existing approval preview before creating another.');
    const previewId = randomUUID();
    previews.set(previewId, { args, token: preview.confirmationToken, expiresAt: Date.parse(preview.expiresAtUtc), clientId: (await status()).clientId });
    const { confirmationToken: _secret, ...visible } = preview;
    return { ...visible, previewId };
  }

  /** Called only by the explicit GUI Approve action for the displayed preview. */
  async function confirmPolicy(previewId) {
    const preview = previews.get(previewId);
    if (!preview || preview.expiresAt <= clock() || preview.clientId !== (await status()).clientId) fail('policy_preview_expired', 'Request a fresh policy preview before approving.');
    previews.delete(previewId);
    const result = unwrap(await mcp('act_in_flusso', { ...preview.args, confirmed: true, confirmationToken: preview.token }));
    return assertGrant(result, preview.args.pathParameters.id);
  }

  async function runApprovedSignal({ accountId, authorizationId, body, idempotencyKey }) {
    id(accountId); id(authorizationId); retryKey(idempotencyKey);
    if (!runValid(body) || body.hourlySlotUtc !== hour(clock())) fail('run_invalid', 'Use the current UTC hour and exact positive base quantity and limit price.');
    await requireOperations(['runPromptTradingAuthorization', 'getPromptTradingRunByKey']);
    let value;
    try {
      value = await mcp('act_in_flusso', { operationId: 'runPromptTradingAuthorization', pathParameters: { id: accountId, authorizationId }, headers: { 'Idempotency-Key': idempotencyKey }, body });
      if (value.result?.schemaVersion === 'product.prompt_trading_run.v1') return assertRun(value.result, accountId, authorizationId, idempotencyKey, body);
      // A conflict can identify a previously accepted request. Without the
      // canonical receipt it cannot establish a safe terminal outcome.
      if (value.outcome === 'failed' && value.status >= 400 && value.status < 500 && value.status !== 409) return { status: 'blocked', submitted: false, riskAccepted: false, message: 'Flusso refused the request before returning a canonical run.', idempotencyKey };
    } catch (error) {
      if (error instanceof CloudError && error.code === 'connection_denied') return { status: 'blocked', submitted: false, riskAccepted: false, message: 'Reconnect or approve the required access before this request can be admitted.', idempotencyKey };
    }
    // Never retry a possibly delivered POST here. The caller has already saved its
    // exact original attempt and must pause this policy until canonical readback.
    return { status: 'unknown', submitted: false, message: 'The request may have reached execution. Preserve its body and original key, pause execution, and reconcile this exact run.', idempotencyKey };
  }

  async function reconcileRunByKey({ accountId, authorizationId, idempotencyKey }) {
    id(accountId); id(authorizationId); retryKey(idempotencyKey);
    await requireOperations(['getPromptTradingRunByKey']);
    const value = await read('getPromptTradingRunByKey', { id: accountId, authorizationId }, null, { 'Idempotency-Key': idempotencyKey });
    if (value.status === 404 && value.result?.error?.code === 'prompt_run_not_found') return null;
    if (value.result?.schemaVersion === 'product.prompt_trading_run.v1') return assertRun(value.result, accountId, authorizationId, idempotencyKey);
    fail('run_reconciliation_unavailable', 'The original run is still unresolved. Keep execution paused.');
  }

  return { status, beginConnect, disconnect, capabilities, discoverExecutionChoices, readJournal, listPolicies, getPolicy, previewPolicy, confirmPolicy, runApprovedSignal, reconcileRunByKey };
}
