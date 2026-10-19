#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createListener } from '../src/listener.mjs';
import { parseClassification } from '../src/model.mjs';
import { openStore } from '../src/store.mjs';

const NOW = Date.parse('2026-10-13T00:00:00Z');
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const ORDERS = [
  { instrumentId: 'example-a:REPLAYUSD', side: 'buy', quantity: 2, limitPrice: 10 },
  { instrumentId: 'example-b:REPLAYUSD', side: 'sell', quantity: 1, limitPrice: 20 },
];
const fixtureClassify = async () => ({ decision: 'candidate', reason: 'Synthetic structured research matches the fixture instructions.' });
const ticket = (id, orders = ORDERS) => `## Synthetic hedge\n\n\`\`\`flusso-orders\n${JSON.stringify({ id, together: true, orders })}\n\`\`\`\n`;
const signal = () => ({
  schemaVersion: 'product.journal_signal.v1', strategyDefinitionId: 'synthetic:delta-neutral', strategyName: 'Synthetic delta-neutral research',
  sourceOperationId: 'syntheticReplay', sourceRecordId: 'synthetic-source-1', sourceAsOfUtc: new Date(NOW).toISOString(), quality: 'fresh', action: 'observe',
  legs: ORDERS.map(order => ({
    asset: { instrumentId: order.instrumentId, nativeInstrumentId: 'REPLAYUSD', assetKey: 'REPLAY', assetGroup: 'futures', instrumentType: 'perpetual', venue: order.instrumentId.split(':')[0], symbol: 'REPLAY/USD', source: 'synthetic-replay', observedAtUtc: new Date(NOW).toISOString(), quality: 'fresh' },
    side: order.side, direction: order.side === 'buy' ? 'long' : 'short', quantity: order.quantity, quantityUnit: 'contracts', quantityAsset: 'REPLAY', notionalUsd: 20, referencePrice: order.limitPrice,
  })),
});

async function fixture(action, { classify = fixtureClassify, unknown = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-listener-replay-'));
  let store, listener;
  const submissions = [], classifications = [], readbacks = [];
  try {
    // No vault, credentials, app data directory, HTTP client or venue adapter exists here.
    store = await openStore({ directory, encryptionKey: randomBytes(32), clock: () => new Date(NOW).toISOString() });
    const notebookId = store.notebooks()[0].id;
    store.saveSettings({ ...store.settings(), enabled: true, executionEnabled: true, accountId: ACCOUNT, notebookIds: [notebookId], instructions: 'Flag structured two-leg delta-neutral research for review.', risk: { maxOrderUsd: 25, maxTicketUsd: 40, maxLeverage: 2, maxSlippagePct: 1, minVolume24hUsd: null, together: true } });
    const cloud = Object.freeze({
      status: async () => ({ connected: true, clientId: 'synthetic-replay', connectionId: 'synthetic-connection', scopes: ['mcp:read', 'mcp:write'] }),
      submitOrders: async attempt => {
        submissions.push(structuredClone(attempt));
        return unknown ? { status: 'unknown', lines: [], message: 'Synthetic lost receipt.' }
          : { status: 'submitted', lines: attempt.orders.map(order => ({ ...order, status: 'submitted', orderId: null, message: 'SIMULATED: in-process fake submission only.' })), message: 'SIMULATED' };
      },
      reconcileOrders: async attempt => { readbacks.push(structuredClone(attempt)); return null; },
    });
    const create = () => createListener({ store, cloud, clock: () => NOW, classify: async input => {
      const result = parseClassification(JSON.stringify(await classify(input)));
      classifications.push(result); return result;
    } });
    listener = create(); listener.start();
    const note = additions => ({ notebookId, title: 'Synthetic Listener replay', status: 'watching', source: 'agent', body: 'Synthetic research only.', signal: null, ...additions });
    return await action({ store, note, submissions, classifications, readbacks, tick: () => listener.tick(), restart: async () => { await listener.stop(); listener = create(); listener.start(); } });
  } finally {
    await listener?.stop(); store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Research-only subset also accepts a trusted, isolated local classifier. */
export async function replayResearch({ classify = fixtureClassify } = {}) {
  const cases = [];
  cases.push(await fixture(async ({ store, note, tick, submissions, classifications }) => {
    store.createEntry(note({ status: 'reviewed', body: `## Synthetic research\n\n\`\`\`json\n${JSON.stringify({ proposedOrders: ORDERS })}\n\`\`\`` }));
    await tick();
    assert.equal(classifications.length, 0); assert.equal(submissions.length, 0); assert.equal(store.all('attempt').length, 0);
    return { name: 'reviewed_proposed_orders', passed: true, classifications: 0, mockSubmissions: 0 };
  }, { classify }));
  cases.push(await fixture(async ({ store, note, tick, submissions, classifications }) => {
    store.createEntry(note({ signal: signal(), body: '## Synthetic research\n\nTwo equal-notional long/short observations. No submission is requested.' }));
    await tick(); await tick();
    assert.equal(classifications.length, 1); assert.equal(submissions.length, 0); assert.equal(store.all('attempt').length, 0);
    assert.equal(store.all('activity')[0].decision, classifications[0].decision);
    return { name: 'watching_structured_research', passed: true, classifications: 1, classification: classifications[0], mockSubmissions: 0 };
  }, { classify }));
  return { simulated: true, cloudTransport: 'in-process fakes only', realVenueCalls: 0, cases };
}

export async function runListenerReplay() {
  const research = await replayResearch();
  const cases = [...research.cases];
  cases.push(await fixture(async ({ store, note, tick, restart, submissions, classifications }) => {
    const original = store.createEntry(note({ body: ticket('synthetic-once') }));
    await tick();
    assert.equal(submissions.length, 1); assert.equal(classifications.length, 0);
    // Local maxLeverage is a ceiling gate only; it is not injected unless the ticket requests it.
    assert.deepEqual(submissions[0].orders.map(order => order.conditions), Array(2).fill({ maxSlippagePct: 1, maxNotionalUsd: 20 }));
    assert.equal(submissions[0].orders[0].placeAtUtc, submissions[0].orders[1].placeAtUtc);
    const decided = store.entry(original.id);
    assert.equal(decided.status, 'reviewed'); assert.match(decided.body, /## Listener result/);
    store.updateEntry(original.id, { ...note({ body: ticket('synthetic-once', ORDERS.map(order => ({ ...order, quantity: order.quantity * 2 }))) }), version: decided.version });
    store.createEntry(note({ body: ticket('synthetic-once') }));
    await tick(); await restart(); await tick();
    assert.equal(submissions.length, 1); assert.equal(store.all('attempt').length, 1);
    return { name: 'explicit_ticket_edits_copies_restart', passed: true, classifications: 0, mockSubmissions: 1, retainedAttempts: 1 };
  }));
  cases.push(await fixture(async ({ store, note, tick, restart, submissions, readbacks }) => {
    store.createEntry(note({ body: ticket('synthetic-unknown') }));
    await tick();
    const original = structuredClone(store.all('attempt')[0]);
    store.createEntry(note({ body: ticket('synthetic-held') }));
    await tick(); await restart(); await tick();
    store.saveSettings({ ...store.settings(), executionEnabled: false }); await tick();
    assert.equal(submissions.length, 1); assert.equal(readbacks.length, 3);
    assert.equal(store.all('attempt').length, 1); assert.equal(store.all('attempt')[0].status, 'unknown');
    for (const read of readbacks) { assert.equal(read.idempotencyKey, original.idempotencyKey); assert.deepEqual(read.orders, original.orders); }
    assert.equal(store.all('activity').some(row => row.status === 'waiting'), true);
    return { name: 'unknown_is_read_only_and_holds_new_ticket', passed: true, mockSubmissions: 1, mockReadbacks: 3, replacementSubmissions: 0 };
  }, { unknown: true }));
  return { ...research, classificationMode: 'synthetic fixture', warning: 'SIMULATED. Mock submissions are not live orders or fills.', cases, mockSubmissions: cases.reduce((sum, row) => sum + row.mockSubmissions, 0) };
}

if (import.meta.main) {
  if (process.argv.length !== 2) { console.error('Usage: node scripts/replay-listener.mjs (synthetic fixtures only; no live transport)'); process.exitCode = 1; }
  else runListenerReplay().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error('Offline Listener replay failed:', error.message); process.exitCode = 1; });
}
