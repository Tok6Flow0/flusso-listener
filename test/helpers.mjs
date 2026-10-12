import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.mjs';

export const now = Date.parse('2026-10-12T01:00:30Z');
export const accountId = '00000000-0000-4000-8000-000000000001';
export const notebookId = '00000000-0000-4000-8000-000000000003';
export function memoryVault() { const rows = new Map(); return { get: async key => rows.get(key) ?? null, set: async (key, value) => { rows.set(key, value); }, delete: async key => rows.delete(key) }; }
export async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-listener-test-')), key = randomBytes(32);
  const store = await openStore({ directory, encryptionKey: key, clock: () => new Date(now).toISOString() });
  return { store, directory, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
export function note(store, additions = {}) { return { notebookId: store.notebooks().find(row => row.origin === 'local').id, title: 'Bitcoin research', body: '## Morning\nA private observation.', status: 'watching', source: 'agent', ...additions }; }
export function signal(additions = {}) { return { schemaVersion: 'product.journal_signal.v1', strategyDefinitionId: 'test:research', strategyName: 'Research fixture', sourceOperationId: 'getCanonicalStrategySignals', sourceRecordId: 'fixture-source-1', sourceAsOfUtc: new Date(now - 1000).toISOString(), quality: 'fresh', action: 'buy', legs: [{ asset: { instrumentId: 'coinbase:spot:BTC-USD', nativeInstrumentId: 'BTC-USD', assetKey: 'BTC', assetGroup: 'spot', instrumentType: 'spot', venue: 'coinbase', symbol: 'BTC/USD', source: 'fixture', observedAtUtc: new Date(now - 1000).toISOString(), quality: 'fresh' }, side: 'buy', direction: 'long', quantity: 0.0001, quantityUnit: 'base', quantityAsset: 'BTC', referencePrice: 50000, notionalUsd: 5 }], ...additions }; }
export const hedge = [
  { instrumentId: 'gate:KAIA_USDT', side: 'buy', quantity: 120, limitPrice: 0.1234, conditions: { maxSlippagePct: 3 } },
  { instrumentId: 'bybit:KAIAUSDT', side: 'sell', quantity: 12, limitPrice: 0.1236 },
];
export function ticket(value = {}) { return `## Hedge\n\nShort the richer funding leg.\n\n\`\`\`flusso-orders\n${JSON.stringify({ id: 'kaia-2026-10-12T01', together: true, orders: hedge, ...value }, null, 2)}\n\`\`\`\n`; }
export function fakeCloud(overrides = {}) { return { status: async () => ({ connected: true, clientId: 'fixture-client', scopes: ['mcp:read', 'mcp:write'], expiresAt: now + 10000 }), readJournal: async () => ({ notebooks: [], entries: [], complete: true, asOfUtc: new Date(now).toISOString() }), listAccounts: async () => [{ id: accountId, displayName: 'Primary', publicId: 'ACCOUNT001' }], submitOrders: async ({ orders }) => ({ status: 'blocked', lines: orders.map(order => ({ ...order, status: 'blocked', orderId: null, riskCode: 'fixture', message: 'Fixture refusal.' })), message: null }), ...overrides }; }
export function enable(store, additions = {}) { const old = store.settings(); return store.saveSettings({ ...old, enabled: true, executionEnabled: true, notebookIds: store.notebooks().map(row => row.id), accountId, risk: { maxSlippagePct: 2, maxOrderUsd: 50, maxTicketUsd: 100, maxLeverage: 10, minVolume24hUsd: null, together: true }, ...additions }); }
