import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ID as UUID } from './schema.mjs';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 50;
const PROFILE_CACHE_MS = 120000;
const KEY = /^[!-~]{8,160}$/;
const SCOPES = ['mcp:read', 'mcp:write', 'offline_access'];
const ORDER_TIMEOUT_MS = 120000;
const LINE_STATUSES = ['submitted', 'blocked', 'unknown', 'not_sent'];

export class CloudError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'CloudError'; this.code = code; this.status = status; }
}

function fail(code, message, status) { throw new CloudError(code, message, status); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sourceIdentity(value, maximum) { return typeof value === 'string' && value.length <= maximum && value.trim().length > 0 && value === value.trim() && !/\p{Cc}/u.test(value); }
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_identity', 'Use an owned canonical account identifier.'); return value; }
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

function equalId(left, right) { return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase(); }
function short(value, maximum = 300) { return typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').trim().slice(0, maximum) : ''; }

function batchLines(receipt, accountId, key, orders) {
  if (!object(receipt) || receipt.schemaVersion !== 'product.manual_order_batch.v1' || !equalId(receipt.accountId, accountId)
    || receipt.idempotencyKey !== key || !Array.isArray(receipt.orders) || receipt.orders.length !== orders.length) return null;
  const lines = receipt.orders.map((line, index) => object(line) && LINE_STATUSES.includes(line.status)
    && line.instrumentId === orders[index].instrumentId && line.side === orders[index].side
    && line.quantity === orders[index].quantity && line.limitPrice === orders[index].limitPrice
    && line.submitted === (line.status === 'submitted') && typeof line.riskAccepted === 'boolean'
    ? { instrumentId: line.instrumentId, side: line.side, quantity: line.quantity, limitPrice: line.limitPrice, status: line.status,
      orderId: typeof line.orderId === 'string' ? line.orderId : null, canonicalInstrumentId: typeof line.canonicalInstrumentId === 'string' ? line.canonicalInstrumentId : null,
      commandId: typeof line.commandId === 'string' ? line.commandId : null, submitted: line.submitted, riskAccepted: line.riskAccepted, riskCode: typeof line.riskCode === 'string' ? short(line.riskCode, 80) : null, message: short(line.message) }
    : null);
  return lines.every(Boolean) ? lines : null;
}

/** One status for the whole ticket. Unknown or unsent lines require readback. */
export function ticketStatus(lines) {
  if (lines.some((line) => line.status === 'unknown' || line.status === 'not_sent')) return 'unknown';
  if (lines.every((line) => line.status === 'submitted')) return 'submitted';
  return lines.some((line) => line.status === 'submitted') ? 'partial' : 'blocked';
}

/** The vault stores the complete credential bundle in the operating-system vault. */
export function createCloudClient({ origin = 'https://flusso.stream', vault, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) fail('origin_invalid', 'Cloud connections require an exact HTTPS origin.');
  if (!vault || ['get', 'set', 'delete'].some((method) => typeof vault[method] !== 'function')) throw new TypeError('An operating-system vault adapter is required.');
  const vaultName = `flusso.listener.oauth:${origin}`;
  let refreshPending = null; let connectionPending = false; let credentialGeneration = 0;
  let profileCache = null, profilePending = null;
  let vaultWrites = Promise.resolve();
  const clearProfile = () => { profileCache = null; profilePending = null; };
  const profileIdentity = (credentials) => `${credentials.clientId}\0${credentials.connectionId ?? ''}`;
  const requireGeneration = (generation) => { if (generation !== credentialGeneration) fail('connection_changed', 'This connection changed while the request was in progress.'); };
  const bundle = async () => { const value = await vault.get(vaultName); return value ? parseJson(value) : null; };
  const writeVault = (action) => { const next = vaultWrites.catch(() => {}).then(action); vaultWrites = next; return next; };
  const save = (value, generation) => writeVault(async () => {
    if (generation !== credentialGeneration) fail('connection_changed', 'This connection changed while the request was in progress.');
    await vault.set(vaultName, JSON.stringify(value));
  });

  async function request(endpoint, { timeoutMs = 20000, ...options } = {}) {
    let response;
    try { response = await fetchImpl(endpoint, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), ...options }); }
    catch { fail('connection_unavailable', 'The cloud request did not return a definitive response.'); }
    const text = await readText(response);
    return { response, text };
  }

  async function token(endpoint, values, previous = {}, generation = credentialGeneration) {
    const { response, text } = await request(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(values).toString() });
    const result = parseJson(text);
    if (!response.ok) {
      if (result.error === 'invalid_grant' && generation === credentialGeneration) {
        credentialGeneration += 1; clearProfile(); await writeVault(() => vault.delete(vaultName));
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
    if (!current?.accessToken || !current?.clientId || !current?.refreshToken) { clearProfile(); fail('not_connected', 'Connect your Flusso account first.'); }
    if (current.expiresAt > clock() + 30000) return { ...current, generation };
    if (!refreshPending) refreshPending = (async () => {
      const refreshed = await token(safeEndpoint(current.tokenEndpoint, origin, '/oauth/token'), { grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: current.clientId, resource: `${origin}/mcp` }, current, generation);
      await save(refreshed, generation); return { ...refreshed, generation };
    })().finally(() => { refreshPending = null; });
    return refreshPending;
  }

  async function mcp(name, args, { timeoutMs, beforeDispatch } = {}) {
    const credentials = await access();
    if (credentials.generation !== credentialGeneration) fail('connection_changed', 'This connection changed while the request was in progress.');
    const requestId = randomUUID();
    await beforeDispatch?.();
    requireGeneration(credentials.generation);
    const { response, text } = await request(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${credentials.accessToken}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }), ...(timeoutMs ? { timeoutMs } : {}) });
    requireGeneration(credentials.generation);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) clearProfile();
      fail(response.status === 401 || response.status === 403 ? 'connection_denied' : 'cloud_unavailable', 'Flusso could not complete this request.', response.status);
    }
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
    if (value.ok !== true || !object(value.result)) {
      if (value.status === 401 || value.status === 403) clearProfile();
      fail('operation_failed', 'Flusso refused this operation.', Number(value.status) || 0);
    }
    return value.result;
  }
  const read = async (operationId, pathParameters, query, headers) => mcp('read_flusso', { operationId, ...(pathParameters ? { pathParameters } : {}), ...(query ? { query } : {}), ...(headers ? { headers } : {}) });

  async function status() {
    const current = await bundle();
    const connected = Boolean(current?.refreshToken && current?.clientId);
    if (!connected) clearProfile();
    const cached = connected && profileCache?.generation === credentialGeneration && profileCache.identity === profileIdentity(current) && profileCache.expiresAt > clock() ? { ...profileCache.value } : null;
    return { connected, scopes: current?.scopes ?? [], expiresAt: current?.expiresAt ?? null, clientId: current?.clientId ?? null, connectionId: current?.connectionId ?? null, connectionExpiresAt: current?.connectionExpiresAt ?? null, profile: cached };
  }

  async function profile() {
    if (connectionPending) fail('connection_pending', 'Complete the browser connection before loading the account profile.');
    const generation = credentialGeneration, current = await bundle();
    requireGeneration(generation);
    if (!current?.refreshToken || !current?.clientId) { clearProfile(); fail('not_connected', 'Connect your Flusso account first.'); }
    const identity = profileIdentity(current);
    if (profileCache?.generation === generation && profileCache.identity === identity && profileCache.expiresAt > clock()) return { ...profileCache.value };
    if (profilePending?.generation === generation && profilePending.identity === identity) return profilePending.promise;
    const pending = { generation, identity };
    profilePending = pending;
    pending.promise = (async () => {
      await requireOperations(['getProfile']); requireGeneration(generation);
      // flusso.400369b5edb1: reuse the owned profile MCP read, projecting only
      // the account label; security, session and other profile fields stay private.
      const result = unwrap(await read('getProfile')); requireGeneration(generation);
      const account = result.profile;
      if (result.schemaVersion !== 'product.profile.v1' || !object(account)
        || typeof account.fullName !== 'string' || account.fullName.length > 160 || /\p{Cc}/u.test(account.fullName)
        || typeof account.email !== 'string' || account.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) || /\p{Cc}/u.test(account.email)) {
        fail('profile_response_invalid', 'Flusso returned an invalid account display profile.');
      }
      const value = { displayName: account.fullName.trim() || null, email: account.email };
      requireGeneration(generation);
      profileCache = { generation, identity, expiresAt: clock() + PROFILE_CACHE_MS, value };
      return { ...value };
    })().finally(() => { if (profilePending === pending) profilePending = null; });
    return pending.promise;
  }

  async function beginConnect({ openBrowser, listenCallback }) {
    if (connectionPending) fail('connection_pending', 'Complete the existing browser connection first.');
    if (typeof openBrowser !== 'function' || typeof listenCallback !== 'function') throw new TypeError('Browser and loopback callback adapters are required.');
    connectionPending = true;
    const generation = ++credentialGeneration;
    clearProfile();
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
      await save(connected, generation);
      return status();
    } finally { connectionPending = false; await callback?.close?.(); }
  }

  async function disconnect() { credentialGeneration += 1; clearProfile(); await writeVault(() => vault.delete(vaultName)); }

  async function listAccounts() {
    await requireOperations(['listTradingAccounts']);
    // flusso.e9c4b572812f: reuse the owned account read. Choosing an account grants nothing.
    const directory = unwrap(await read('listTradingAccounts'));
    if (directory.schemaVersion !== 'product.trading_accounts.v1' || !Array.isArray(directory.rows)
      || directory.rows.length > 1000 || directory.rows.some((row) => !UUID.test(row?.id ?? '')
        || !sourceIdentity(row.displayName, 120) || !sourceIdentity(row.publicId, 100))) fail('account_response_invalid', 'Flusso returned an invalid owned account list.');
    return directory.rows.map(({ id: accountId, displayName, publicId }) => ({ id: accountId, displayName, publicId }));
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

  /**
   * Places one ticket through Flusso's existing order list (flusso.214799013f6d).
   * The owner turned on auto-trade for this connection, which is the approval the
   * preview asks for; Flusso still checks ownership, plan, risk and venue terms.
   * Freeze these orders/key before dispatch. Unknown results are read back only;
   * automatic POST replay could create a previously unsent line.
   */
  async function submitOrders({ accountId, orders, idempotencyKey, reference = 'a Journal ticket' }, { canDispatch = async () => true } = {}) {
    id(accountId); retryKey(idempotencyKey);
    const generation = credentialGeneration;
    orders = structuredClone(orders);
    if (!Array.isArray(orders) || orders.length < 1 || orders.length > 6000) fail('orders_invalid', 'A ticket needs at least one order.');
    const blocked = (message) => ({ status: 'blocked', lines: [], message });
    try { await requireOperations(['submitManualFuturesLimitOrder']); }
    catch (error) {
      return blocked(error instanceof CloudError && error.code === 'operation_unavailable'
        ? 'Your Flusso connection cannot place orders. Reconnect with write access and check that your plan includes live trading.'
        : 'Flusso could not check order access. No order was sent. Check your connection before creating another ticket.');
    }
    const args = {
      operationId: 'submitManualFuturesLimitOrder', pathParameters: { id: accountId }, headers: { 'Idempotency-Key': idempotencyKey },
      body: { schemaVersion: 'product.manual_order_request.v3', orders, confirmation: {
        accountId, operationType: 'manual_trade_requested',
        expectedEffect: short(`Flusso Listener places ${orders.length} limit order${orders.length === 1 ? '' : 's'} from ${reference}.`, 1000),
        riskImpact: 'Uses real funds. Each order is held to its own conditions, account risk and venue terms.',
        rollbackPath: 'Cancel open orders or close the resulting positions in Flusso.' } },
    };
    // A preview sends nothing, so its failures are definitive refusals.
    let preview;
    try { preview = await mcp('act_in_flusso', args); }
    catch { return blocked('Flusso could not prepare the order preview. No order was sent. Check your connection before creating another ticket.'); }
    if (preview.error === 'operation_not_available') return blocked('Your Flusso plan or connection does not allow placing orders.');
    if (preview.schemaVersion !== 'flusso.mcp_confirmation.v1' || preview.confirmationRequired !== true || typeof preview.confirmationToken !== 'string'
      || preview.operation?.operationId !== args.operationId || preview.request?.method !== 'POST'
      || preview.request?.path !== `/api/v1/me/trading-accounts/${accountId}/manual-orders`
      || preview.request?.query !== null || preview.request?.headers?.['Idempotency-Key'] !== idempotencyKey
      || !isDeepStrictEqual(preview.request?.body, args.body) || preview.effect?.liveTradingRequested !== true
      || preview.effect?.destructive !== true || Date.parse(preview.expiresAtUtc) <= clock()
      || !Number.isFinite(Date.parse(preview.expiresAtUtc))) {
      return blocked(short(preview.message) || 'Flusso refused the order preview. No order was sent.');
    }
    let value, dispatched = false;
    try { value = await mcp('act_in_flusso', { ...args, confirmed: true, confirmationToken: preview.confirmationToken }, { timeoutMs: ORDER_TIMEOUT_MS, beforeDispatch: async () => {
      requireGeneration(generation);
      if (!await canDispatch()) fail('execution_stopped', 'Auto-trade or its account changed before confirmation. No order was sent.');
      requireGeneration(generation); dispatched = true;
    } }); }
    catch (error) {
      if (!dispatched) return blocked(error instanceof CloudError && error.code === 'execution_stopped' ? error.message : 'The connection changed before confirmation. No order was sent.');
      return { status: 'unknown', lines: [], message: 'Flusso did not confirm the result. The listener will use read-only checks; it will not resend this ticket.' };
    }
    const lines = batchLines(value.result, accountId, idempotencyKey, orders);
    if (lines) return { status: ticketStatus(lines), lines, message: null };
    if (value.result?.schemaVersion === 'product.error.v1' && value.status >= 400 && value.status < 500) {
      return blocked(short(value.result.error?.message) || short(value.result.error?.code) || 'Flusso refused the orders.');
    }
    if (value.error === 'confirmation_invalid') return blocked('The order preview expired before it was confirmed. No order was sent.');
    return { status: 'unknown', lines: [], message: 'Flusso did not return a clear result. The listener will use read-only checks; it will not resend this ticket.' };
  }

  /** Read only exact canonical order IDs retained in the original receipt. */
  async function reconcileOrders(attempt) {
    const previous = attempt.receipt;
    if (!Array.isArray(previous?.lines) || previous.lines.length !== attempt.orders.length) return null;
    const unresolved = previous.lines.filter(line => line.status === 'unknown' || line.status === 'not_sent');
    // A missing receipt/ID is unknown, never evidence that an order was not sent.
    if (!unresolved.length) return previous;
    if (unresolved.some(line => !UUID.test(line.orderId ?? '') || !UUID.test(line.canonicalInstrumentId ?? '') || line.riskAccepted !== true)) return null;
    await requireOperations(['getTradingAccountResource']);
    const needed = new Map(unresolved.map(line => [line.orderId.toLowerCase(), line]));
    const found = new Map(), seen = new Set(); let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // flusso.37f7160f47e1: reuse canonical account orders; never submit during recovery.
      const result = unwrap(await read('getTradingAccountResource', { id: id(attempt.accountId), resource: 'orders' }, { limit: 100, ...(cursor ? { cursor } : {}) }));
      if (result.schemaVersion !== 'canonical_orders.v1' || !equalId(result.accountId, attempt.accountId)
        || !Array.isArray(result.rows) || typeof result.hasMore !== 'boolean'
        || result.hasMore !== (typeof result.nextCursor === 'string' && result.nextCursor.length > 0)
        || result.nextCursor != null && seen.has(result.nextCursor)) fail('order_readback_invalid', 'The canonical order readback was invalid.');
      for (const row of result.rows) {
        const line = needed.get(String(row?.id).toLowerCase());
        const orderStatus = String(row?.status).toLowerCase().replaceAll('_', '');
        if (line && row.instrumentId === line.canonicalInstrumentId && row.side === line.side
          && row.requestedQuantity === line.quantity && row.limitPrice === line.limitPrice
          && typeof row.externalOrderId === 'string' && row.externalOrderId.trim()
          && ['pending', 'open', 'new', 'partiallyfilled', 'filled', 'canceled', 'cancelled', 'closed'].includes(orderStatus)) found.set(row.id.toLowerCase(), row);
      }
      if (found.size === needed.size) {
        const lines = previous.lines.map(line => found.has(String(line.orderId).toLowerCase())
          ? { ...line, status: 'submitted', submitted: true, message: `Canonical order readback: ${found.get(line.orderId.toLowerCase()).status}. Submission is not a fill.` } : line);
        return { status: ticketStatus(lines), lines, message: null };
      }
      if (!result.hasMore) break;
      cursor = result.nextCursor; seen.add(cursor);
    }
    return null;
  }

  /**
   * Notes the listener's decision on a cloud Journal entry (flusso.updateJournalEntry):
   * the same entry with its result appended and status reviewed. The signal snapshot
   * is omitted so the server keeps it. Journal writes never place an order.
   */
  async function updateJournalEntry({ entry, body, status, idempotencyKey }) {
    retryKey(idempotencyKey);
    if (!UUID.test(entry?.id ?? '') || !UUID.test(entry?.notebookId ?? '') || !Number.isInteger(entry.version) || typeof body !== 'string' || !['watching', 'reviewed', 'closed'].includes(status)) fail('journal_update_invalid', 'A complete cloud entry and its latest version are required.');
    const generation = credentialGeneration;
    await requireOperations(['updateJournalEntry']);
    const args = { operationId: 'updateJournalEntry', pathParameters: { entryId: entry.id }, headers: { 'Idempotency-Key': idempotencyKey },
      body: { notebookId: entry.notebookId, title: entry.title, body, instrument: entry.instrument ?? null, venue: entry.venue ?? null, status,
        observedAtUtc: entry.observedAtUtc ?? null, source: entry.source === 'manual' ? 'manual' : 'agent', version: entry.version } };
    const preview = await mcp('act_in_flusso', args);
    if (preview.schemaVersion !== 'flusso.mcp_confirmation.v1' || typeof preview.confirmationToken !== 'string' || preview.operation?.operationId !== args.operationId) fail('journal_update_refused', short(preview.message) || 'Flusso refused the Journal update.');
    requireGeneration(generation);
    const value = await mcp('act_in_flusso', { ...args, confirmed: true, confirmationToken: preview.confirmationToken });
    requireGeneration(generation);
    const updated = value.result?.entry;
    if (value.result?.schemaVersion !== 'product.journal_entry.v1' || !object(updated) || !equalId(updated.id, entry.id) || !Number.isInteger(updated.version) || updated.version <= entry.version) {
      fail(value.status === 409 ? 'journal_update_conflict' : 'journal_update_failed', short(value.result?.error?.message) || 'Flusso did not confirm the Journal update.', Number(value.status) || 0);
    }
    return updated;
  }

  /**
   * Closes owned positions through Flusso's reduce-only close path
   * (flusso.b5b5efba7adc / closeTradingAccountPositions). Auto-trade on is the
   * local approval; Flusso still checks ownership and venue rules.
   */
  async function closePositions({ accountId, positionIds, idempotencyKey, reference = 'a Journal close ticket' }, { canDispatch = async () => true } = {}) {
    id(accountId); retryKey(idempotencyKey);
    const generation = credentialGeneration;
    positionIds = structuredClone(positionIds);
    if (!Array.isArray(positionIds) || positionIds.length < 1 || positionIds.length > 25 || positionIds.some((value) => !UUID.test(value))) {
      fail('positions_invalid', 'A close ticket needs 1–25 owned position IDs.');
    }
    const blocked = (message) => ({ status: 'blocked', lines: [], message });
    try { await requireOperations(['closeTradingAccountPositions']); }
    catch (error) {
      return blocked(error instanceof CloudError && error.code === 'operation_unavailable'
        ? 'Your Flusso connection cannot close positions. Reconnect with write access.'
        : 'Flusso could not check close access. No close was sent.');
    }
    const args = {
      operationId: 'closeTradingAccountPositions', pathParameters: { id: accountId }, headers: { 'Idempotency-Key': idempotencyKey },
      body: { positionIds },
    };
    let preview;
    try { preview = await mcp('act_in_flusso', args, { timeoutMs: 240000 }); }
    catch { return blocked('Flusso could not prepare the close. No close was sent.'); }
    if (preview.error === 'operation_not_available') return blocked('Your Flusso plan or connection does not allow closing positions.');
    const directReceipt = object(preview?.result) && preview.ok === true && preview.result.schemaVersion === 'product.position_close_operation.v1';
    if (!directReceipt && (preview.schemaVersion !== 'flusso.mcp_confirmation.v1' || preview.confirmationRequired !== true || typeof preview.confirmationToken !== 'string'
      || preview.operation?.operationId !== args.operationId || preview.request?.method !== 'POST'
      || preview.request?.path !== `/api/v1/me/trading-accounts/${accountId}/positions/close`
      || preview.request?.query !== null || preview.request?.headers?.['Idempotency-Key'] !== idempotencyKey
      || !isDeepStrictEqual(preview.request?.body, args.body) || preview.effect?.destructive !== true || Date.parse(preview.expiresAtUtc) <= clock()
      || !Number.isFinite(Date.parse(preview.expiresAtUtc)))) {
      return blocked(short(preview.message) || 'Flusso refused the close. No close was sent.');
    }
    let value = directReceipt ? preview : null, dispatched = directReceipt;
    try {
      if (!directReceipt) value = await mcp('act_in_flusso', { ...args, confirmed: true, confirmationToken: preview.confirmationToken }, {
        timeoutMs: ORDER_TIMEOUT_MS,
        beforeDispatch: async () => {
          requireGeneration(generation);
          if (!await canDispatch()) fail('execution_stopped', 'Auto-trade or its account changed before confirmation. No close was sent.');
          requireGeneration(generation); dispatched = true;
        },
      });
    } catch (error) {
      if (!dispatched) return blocked(error instanceof CloudError && error.code === 'execution_stopped' ? error.message : 'The connection changed before confirmation. No close was sent.');
      return { status: 'unknown', lines: [], message: 'Flusso did not confirm the close. Check positions in Flusso; this ticket will not be resent.' };
    }
    const receipt = value.result;
    if (object(receipt) && receipt.schemaVersion === 'product.position_close_operation.v1' && equalId(receipt.accountId, accountId)
      && Array.isArray(receipt.results) && receipt.results.length === positionIds.length
      && Number.isSafeInteger(receipt.requestedCount) && receipt.requestedCount === positionIds.length
      && Number.isSafeInteger(receipt.closedCount) && receipt.closedCount >= 0 && receipt.closedCount <= positionIds.length) {
      const lines = receipt.results.map((row, index) => {
        const positionId = positionIds[index];
        if (!object(row) || String(row.positionId).toLowerCase() !== positionId.toLowerCase()
          || !['closed', 'rejected', 'not_found'].includes(row.status)) return null;
        if (row.status === 'closed') return { positionId, status: 'submitted', message: short(row.reason) || 'Reduce-only close accepted.' };
        return { positionId, status: 'blocked', message: short(row.reason) || short(row.status) || 'Close refused.' };
      });
      if (lines.every(Boolean)) {
        const closed = lines.filter((line) => line.status === 'submitted').length;
        if (closed !== receipt.closedCount) return { status: 'unknown', lines: [], message: 'Flusso returned inconsistent close counts. Check positions in Flusso; this ticket will not be resent.' };
        const status = closed === lines.length ? 'submitted' : closed === 0 ? 'blocked' : 'partial';
        return { status, lines, message: status === 'blocked' ? (lines.find((line) => line.status === 'blocked')?.message || 'Flusso refused the closes.') : null };
      }
    }
    if (value.result?.schemaVersion === 'product.error.v1' && value.status >= 400 && value.status < 500) {
      return blocked(short(value.result.error?.message) || short(value.result.error?.code) || 'Flusso refused the close.');
    }
    if (value.error === 'confirmation_invalid') return blocked('The close preview expired before it was confirmed. No close was sent.');
    return { status: 'unknown', lines: [], message: 'Flusso did not return a clear close result. Check positions in Flusso; this ticket will not be resent.' };
  }

  return { status, profile, beginConnect, disconnect, capabilities, listAccounts, readJournal, submitOrders, closePositions, reconcileOrders, updateJournalEntry };
}
