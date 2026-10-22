import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRisk, buildOrderRequest, readTicket } from '../src/orders.mjs';
import { hedge, now, ticket } from './helpers.mjs';

const entry = (body, additions = {}) => ({ id: '00000000-0000-4000-8000-000000000009', status: 'watching', body, createdAtUtc: new Date(now - 5000).toISOString(), updatedAtUtc: new Date(now - 5000).toISOString(), ...additions });
const settings = { risk: { maxSlippagePct: null, maxOrderUsd: 900, maxTicketUsd: 1800, maxLeverage: 10, minVolume24hUsd: null, together: true }, maxSignalAgeSeconds: 900 };

test('entries without a ticket are not order requests', () => {
  assert.equal(readTicket('## Notes\n\n```json\n{"orders":[]}\n```'), null);
  assert.equal(buildOrderRequest({ entry: entry('Plain research.'), settings, now }), null);
});

test('a ticket forwards the exact order elements and stamps one shared release time', () => {
  const request = buildOrderRequest({ entry: entry(ticket()), settings, now });
  assert.equal(request.eligible, true);
  assert.equal(request.ticketId, 'kaia-2026-10-12T01');
  assert.deepEqual(request.orders.map(({ placeAtUtc: _at, ...order }) => order), applyRisk(hedge, settings.risk));
  assert.equal(request.orders[0].placeAtUtc, new Date(now + 3000).toISOString());
  assert.equal(request.orders[1].placeAtUtc, request.orders[0].placeAtUtc);
  const separate = buildOrderRequest({ entry: entry(ticket({ together: false })), settings, now });
  assert.equal(separate.orders.some((order) => 'placeAtUtc' in order), false);
});

test('owner risk settings only tighten each order', () => {
  const tightened = applyRisk(hedge, { maxSlippagePct: 1, maxOrderUsd: 25, minVolume24hUsd: 100000 });
  assert.deepEqual(tightened.map((order) => order.conditions), [
    { maxSlippagePct: 1, maxNotionalUsd: 25, minVolume24hUsd: 100000 },
    { maxSlippagePct: 1, maxNotionalUsd: 25, minVolume24hUsd: 100000 },
  ]);
  const loose = applyRisk([{ ...hedge[0], conditions: { maxSlippagePct: 0.5, maxNotionalUsd: 10, minVolume24hUsd: 5e6 } }], { maxSlippagePct: 3, maxOrderUsd: 100, minVolume24hUsd: 1000 });
  assert.deepEqual(loose[0].conditions, { maxSlippagePct: 0.5, maxNotionalUsd: 10, minVolume24hUsd: 5e6 });
  assert.equal('conditions' in applyRisk([{ ...hedge[1] }], { maxSlippagePct: null, maxOrderUsd: null, maxTicketUsd: null, maxLeverage: null, minVolume24hUsd: null })[0], false);
});

test('malformed, ambiguous, unsupported or stale tickets are held with a reason', () => {
  const variants = [
    '```flusso-orders\nnot json\n```',
    ticket() + ticket({ id: 'second' }),
    ticket({ execute: true }),
    ticket({ id: 'has spaces' }),
    ticket({ orders: [] }),
    ticket({ orders: [{ ...hedge[0], instrumentId: 'KAIA' }] }),
    ticket({ orders: [{ ...hedge[0], side: 'long' }] }),
    ticket({ orders: [{ ...hedge[0], quantity: 0 }] }),
    ticket({ orders: [{ ...hedge[0], notionalUsd: 100 }] }),
    ticket({ orders: [{ ...hedge[0], conditions: { maxSlippagePct: 101 } }] }),
    ticket({ orders: [{ ...hedge[0], conditions: { leverage: 5 } }] }),
  ];
  for (const body of variants) {
    const request = buildOrderRequest({ entry: entry(body), settings, now });
    assert.equal(request.eligible, false, body); assert.ok(request.reason);
  }
  assert.equal(buildOrderRequest({ entry: entry(ticket(), { status: 'reviewed' }), settings, now }).eligible, false);
  assert.match(buildOrderRequest({ entry: entry(ticket()), settings: { ...settings, maxSignalAgeSeconds: 60 }, now: now + 120000 }).reason, /older than/);
});

test('a stable ticket id is required and remains one dispatch across size, price and copy edits', () => {
  const original = buildOrderRequest({ entry: entry(ticket()), settings, now }).signalIdentity;
  assert.equal(buildOrderRequest({ entry: entry('Edited.\n' + ticket({ orders: [hedge[0]] }), { id: '00000000-0000-4000-8000-00000000000a' }), settings, now }).signalIdentity, original);
  const changed = hedge.map(order => ({ ...order, quantity: order.quantity * 2, limitPrice: order.limitPrice * 2 }));
  assert.equal(buildOrderRequest({ entry: entry(ticket({ orders: changed })), settings, now }).signalIdentity, original);
  assert.equal(buildOrderRequest({ entry: entry(ticket({ id: undefined })), settings, now }).eligible, false);
});

test('windows line endings and tilde fences are read', () => {
  const body = ticket().replaceAll('\n', '\r\n');
  assert.equal(buildOrderRequest({ entry: entry(body), settings, now }).eligible, true);
  assert.equal(readTicket('~~~flusso-orders\n{"id":"tilde-test","orders":[{"instrumentId":"okx:BTC-USDT-SWAP","side":"buy","quantity":1,"limitPrice":60000}]}\n~~~').ticket.orders.length, 1);
});


test('combined notional and leverage caps tighten every independent leg without valuing contracts locally', () => {
  const orders = Array.from({ length: 3 }, (_, index) => ({ ...hedge[0], instrumentId: `gate:ASSET${index}_USDT`, conditions: { maxNotionalUsd: 1000, maxLeverage: 20 } }));
  const capped = applyRisk(orders, { maxOrderUsd: 900, maxTicketUsd: 1800, maxLeverage: 10 });
  assert.deepEqual(capped.map(order => order.conditions), Array(3).fill({ maxNotionalUsd: 600, maxLeverage: 10 }));
  assert.deepEqual(applyRisk([{ ...hedge[0], conditions: { maxNotionalUsd: 100, maxLeverage: 3 } }], { maxOrderUsd: 900, maxTicketUsd: 1800, maxLeverage: 10 })[0].conditions, { maxNotionalUsd: 100, maxLeverage: 3 });
  // Local leverage ceiling alone does not invent a maxLeverage condition on the order.
  assert.deepEqual(applyRisk([{ instrumentId: 'okx:BTC-USDT-SWAP', side: 'buy', quantity: 1, limitPrice: 1 }], { maxOrderUsd: 900, maxTicketUsd: 1800, maxLeverage: 10 })[0].conditions, { maxNotionalUsd: 900 });
  assert.equal(readTicket(ticket({ orders: [{ ...hedge[0], conditions: { maxLeverage: 0.5 } }] })).error.includes('conditions'), true);
});


test('runtime admission independently refuses missing owner bounds and unusable cent allocations', () => {
  for (const key of ['maxOrderUsd', 'maxTicketUsd', 'maxLeverage']) {
    for (const value of [null, undefined, 0, Infinity]) {
      const request = buildOrderRequest({ entry: entry(ticket()), settings: { ...settings, risk: { ...settings.risk, [key]: value } }, now });
      assert.equal(request.eligible, false, key); assert.match(request.reason, /explicit maximum/);
    }
  }
  assert.equal(buildOrderRequest({ entry: entry(ticket()), settings: { ...settings, risk: { ...settings.risk, maxTicketUsd: 0.01 } }, now }).eligible, false);
  assert.equal(buildOrderRequest({ entry: entry(ticket()), settings: { ...settings, risk: { ...settings.risk, maxTicketUsd: Number.MAX_SAFE_INTEGER } }, now }).eligible, false);
});

test('seven independent order ceilings conservatively fit the total permission', () => {
  const seven = Array.from({ length: 7 }, (_, index) => ({ ...hedge[0], instrumentId: `gate:ASSET${index}_USDT` }));
  const request = buildOrderRequest({ entry: entry(ticket({ orders: seven })), settings, now });
  assert.equal(request.eligible, true);
  const ceilings = request.orders.map(order => order.conditions.maxNotionalUsd);
  assert.deepEqual(ceilings, Array(7).fill(257.14));
  assert.ok(ceilings.reduce((sum, amount) => sum + amount, 0) <= 1800);
});

test('a listener result replaces the previous one and keeps the ticket readable', async () => {
  const { withResult, readTicket: read } = await import('../src/orders.mjs');
  const first = withResult(ticket(), { status: 'blocked', reason: 'Flusso refused the orders.', lines: [{ side: 'buy', instrumentId: 'gate:KAIA_USDT', quantity: 120, limitPrice: 0.1234, status: 'blocked', message: 'Too far from the live price.' }], atUtc: '2026-10-12T10:05:00Z' });
  assert.match(first, /\*\*Refused\*\* · 2026-10-12 10:05 UTC/);
  const second = withResult(first, { status: 'review', reason: 'Daily limit reached.', atUtc: '2026-10-12T11:00:00Z' });
  assert.equal(second.match(/## Listener result/g).length, 1);
  assert.doesNotMatch(second, /Refused/);
  assert.equal(read(second).ticket.id, 'kaia-2026-10-12T01');
  const many = Array.from({ length: 400 }, (_, index) => ({ side: 'buy', instrumentId: `venue:INSTRUMENT_${index}`, quantity: 1, limitPrice: 1, status: 'submitted', message: 'x'.repeat(40) }));
  const bounded = withResult('x'.repeat(5000), { status: 'submitted', lines: many, atUtc: '2026-10-12T10:05:00Z' });
  assert.ok(bounded.length <= 20000); assert.match(bounded, /more orders, see Activity/);
});

test('reduce-only close tickets preserve canonical opaque GUIDs and reject ambiguous or duplicate actions', () => {
  const positionIds = ['d93d1eec-2a5e-f058-b846-d12fd573ae1d', 'eff0bb01-73ff-8b54-9b6f-7b491cf9b280'];
  const close = value => '```flusso-close\n' + JSON.stringify({ id: 'close-owned-positions', positionIds, ...value }) + '\n```';
  const request = buildOrderRequest({ entry: entry(close({ positionIds: positionIds.map(id => id.toUpperCase()) })), settings, now });
  assert.equal(request.eligible, true); assert.equal(request.kind, 'close'); assert.deepEqual(request.positionIds, positionIds);
  assert.equal('orders' in request, false, 'Close sizing and side remain execution-owned.');
  assert.equal(buildOrderRequest({ entry: entry(close()), settings: { ...settings, risk: {} }, now }).eligible, true, 'Reduce-only closes need no opening notional allocation.');
  assert.match(readTicket(close({ positionIds: [positionIds[0], positionIds[0].toUpperCase()] })).error, /same position twice/);
  assert.match(readTicket(close({ positionIds: ['malformed'] })).error, /canonical owned position UUID/);
  assert.match(readTicket(close() + '\n' + ticket()).error, /both an order ticket and a close ticket/);
  assert.equal(buildOrderRequest({ entry: entry(close(), { status: 'reviewed' }), settings, now }).eligible, false);
});

test('Journal results retain exact safe risk codes beside original messages without interpreting them', async () => {
  const { withResult } = await import('../src/orders.mjs');
  const compose = line => withResult(ticket(), { status: 'blocked', lines: [{ ...hedge[0], status: 'blocked', ...line }], atUtc: '2026-10-22T15:18:18Z' });
  const result = compose({ riskCode: 'RISK_TRADING_HALTED', message: 'Canonical risk refused this exact action.' });
  assert.match(result, /refused \(RISK_TRADING_HALTED · Canonical risk refused this exact action\.\)/);
  assert.equal(readTicket(result).ticket.id, 'kaia-2026-10-12T01', 'Diagnostic output preserves the original ticket.');
  assert.match(compose({ riskCode: 'condition_market_unavailable', message: 'The instrument has no live market row.' }), /condition_market_unavailable · The instrument has no live market row\./);
  assert.match(compose({ riskCode: 'RISK_FUTURE_CODE', message: null }), /refused \(RISK_FUTURE_CODE\)/, 'Unknown safe codes are preserved without an invented explanation.');
  for (const riskCode of ['RISK_HALTED\n## Injected', '`unsafe`', 'A'.repeat(81), { unsafe: true }]) {
    const bounded = compose({ riskCode, message: 'Original server message.' });
    assert.match(bounded, /refused \(Original server message\.\)/); assert.doesNotMatch(bounded, /Injected|`unsafe`|A{81}/);
  }
  const close = withResult('A close instruction.', { status: 'blocked', lines: [{ positionId: 'd93d1eec-2a5e-f058-b846-d12fd573ae1d', status: 'blocked', riskCode: 'credential_expired', message: 'The venue credential expired.' }], atUtc: '2026-10-22T15:18:18Z' });
  assert.match(close, /credential_expired · The venue credential expired\./);
});
