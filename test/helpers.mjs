import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.mjs';

export const now = Date.parse('2026-10-12T01:00:30Z');
export const accountId = '00000000-0000-4000-8000-000000000001';
export const authorizationId = '00000000-0000-4000-8000-000000000002';
export const notebookId = '00000000-0000-4000-8000-000000000003';
export function memoryVault() { const rows = new Map(); return { get: async key => rows.get(key) ?? null, set: async (key, value) => { rows.set(key, value); }, delete: async key => rows.delete(key) }; }
export async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-listener-test-')), key = randomBytes(32);
  const store = await openStore({ directory, encryptionKey: key, clock: () => new Date(now).toISOString() });
  return { store, directory, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
export function note(store, additions = {}) { return { notebookId: store.notebooks().find(row => row.origin === 'local').id, title: 'Bitcoin research', body: '## Morning\nA private observation.', status: 'watching', source: 'agent', ...additions }; }
export const policy = { instrumentId: 'coinbase:spot:BTC-USD', marketFamily: 'spot_crypto', side: 'buy', orderType: 'limit', baseAsset: 'BTC', quoteAsset: 'USD', maxBaseQuantity: 0.001, maxLimitPrice: 100000, maxOrderQuoteNotionalUsd: 100, maxDailyQuoteNotionalUsd: 100, maxLifetimeQuoteNotionalUsd: 100, startsAtUtc: '2026-10-12T00:00:00Z', expiresAtUtc: '2026-10-13T00:00:00Z', maxAdmittedRuns: 2, slotPolicy: 'current_utc_hour' };
export function signal(additions = {}) { return { schemaVersion: 'product.journal_signal.v1', strategyDefinitionId: 'test:research', strategyName: 'Research fixture', sourceOperationId: 'getCanonicalStrategySignals', sourceRecordId: 'fixture-source-1', sourceAsOfUtc: new Date(now - 1000).toISOString(), quality: 'fresh', action: 'buy', legs: [{ asset: { instrumentId: policy.instrumentId, nativeInstrumentId: 'BTC-USD', assetKey: 'BTC', assetGroup: 'spot', instrumentType: 'spot', venue: 'coinbase', symbol: 'BTC/USD', source: 'fixture', observedAtUtc: new Date(now - 1000).toISOString(), quality: 'fresh' }, side: 'buy', direction: 'long', quantity: 0.0001, quantityUnit: 'base', quantityAsset: 'BTC', referencePrice: 50000, notionalUsd: 5 }], ...additions }; }
export function fakeCloud(overrides = {}) { return { status: async () => ({ connected: true, clientId: 'fixture-client', scopes: ['mcp:read', 'mcp:write'], expiresAt: now + 10000 }), readJournal: async () => ({ notebooks: [], entries: [], complete: true, asOfUtc: new Date(now).toISOString() }), reconcileRunByKey: async () => null, runApprovedSignal: async () => ({ status: 'blocked', submitted: false }), ...overrides }; }
export function enable(store, additions = {}) { const old = store.settings(); return store.saveSettings({ ...old, enabled: true, executionEnabled: true, accountId, authorizationId, policy, ...additions }); }
