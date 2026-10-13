import test from 'node:test';
import assert from 'node:assert/strict';
import { runListenerReplay, replayResearch } from '../scripts/replay-listener.mjs';

test('offline replay exercises real Listener classification, ticket dispatch, durable copies/restart, and unknown recovery with no HTTP', async () => {
  const originalFetch = globalThis.fetch; let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Offline replay attempted HTTP.'); };
  try {
    const report = await runListenerReplay();
    assert.equal(networkCalls, 0); assert.equal(report.realVenueCalls, 0); assert.equal(report.simulated, true);
    assert.match(report.warning, /SIMULATED/); assert.equal(report.cases.length, 4);
    assert.equal(report.cases.every(row => row.passed), true);
    const research = report.cases.find(row => row.name === 'watching_structured_research');
    assert.equal(research.classification.decision, 'candidate'); assert.equal(research.mockSubmissions, 0);
    assert.equal(report.cases.find(row => row.name === 'explicit_ticket_edits_copies_restart').mockSubmissions, 1);
    const unknown = report.cases.find(row => row.name === 'unknown_is_read_only_and_holds_new_ticket');
    assert.equal(unknown.mockSubmissions, 1); assert.equal(unknown.mockReadbacks, 3); assert.equal(unknown.replacementSubmissions, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('isolated research replay accepts a validated local classification without supplying it execution capabilities', async () => {
  let calls = 0;
  const report = await replayResearch({ classify: async input => {
    calls++; assert.equal(input.entry.signal.quality, 'fresh'); assert.equal(input.entry.body.includes('flusso-orders'), false);
    assert.deepEqual(Object.keys(input).sort(), ['entry', 'instructions', 'signal']);
    return { decision: 'review', reason: 'Synthetic local classifier witness.' };
  } });
  assert.equal(calls, 1); assert.equal(report.realVenueCalls, 0);
  assert.equal(report.cases.every(row => row.mockSubmissions === 0), true);
  assert.equal(report.cases[1].classification.decision, 'review');
});
