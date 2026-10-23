import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedFrame, externalUrl, createDraftExitGuard, reportDraftState } from '../desktop/policy.mjs';

const origin = 'http://127.0.0.1:43127';
function frameFixture(url = origin + '/') {
  const mainFrame = { url }, webContents = { mainFrame }, window = { webContents };
  return { window, event: { sender: webContents, senderFrame: mainFrame } };
}

test('desktop IPC accepts only the live window main frame at its private loopback origin', () => {
  const { window, event } = frameFixture();
  assert.equal(trustedFrame(event, window, origin), true);
  event.senderFrame.url = origin + '/#private-launcher-fragment';
  assert.equal(trustedFrame(event, window, origin), true);
  assert.equal(trustedFrame({ ...event, sender: { mainFrame: event.senderFrame } }, window, origin), false);
  assert.equal(trustedFrame({ ...event, senderFrame: { url: origin + '/' } }, window, origin), false);
  assert.equal(trustedFrame(event, null, origin), false);
  const previousMainFrame = event.senderFrame;
  window.webContents.mainFrame = { url: origin + '/' };
  assert.equal(trustedFrame({ ...event, senderFrame: previousMainFrame }, window, origin), false);
});

test('a main frame navigated away from the exact app document loses IPC authority', () => {
  for (const url of [
    'https://flusso.stream/', 'http://127.0.0.1:43128/', 'http://localhost:43127/',
    'http://127.0.0.1:43127.evil.test/', 'http://127.0.0.1:43127/settings',
    origin + '/?frame=untrusted', origin + '/%2f', 'file:///app/index.html',
    'data:text/html,hello', 'about:blank', 'not a URL', '',
  ]) {
    const { window, event } = frameFixture(url);
    assert.equal(trustedFrame(event, window, origin), false, url);
  }
});

test('external navigation permits only canonical HTTPS Flusso URLs without credentials or custom ports', () => {
  assert.equal(externalUrl('https://flusso.stream/app/settings#ai-connections'), 'https://flusso.stream/app/settings#ai-connections');
  assert.equal(externalUrl('https://FLUSSO.stream:443/oauth/authorize?state=synthetic-state'), 'https://flusso.stream/oauth/authorize?state=synthetic-state');
  for (const url of [
    'http://flusso.stream/', 'https://flusso.stream:8443/', 'https://user@flusso.stream/',
    'https://user:password@flusso.stream/', 'https://flusso.stream.evil.test/',
    'https://flusso.stream@evil.test/', 'https://evil.test@flusso.stream/',
    'https://api.flusso.stream/', 'https://flusso.stream./', 'https://127.0.0.1/',
    '//flusso.stream/', '/app/settings', 'javascript:alert(1)', 'file:///tmp/a',
    'data:text/html,hello', '', null,
  ]) assert.throws(() => externalUrl(url), undefined, String(url));
});

test('draft reports accept exactly one boolean only from the current trusted main frame', () => {
  const { window, event } = frameFixture(), reports = [];
  const guard = { reportDirty: value => reports.push(value) };
  for (const args of [[], [null], ['false'], [0], [{}], [true, false]]) assert.equal(reportDraftState(event, window, origin, args, guard), false);
  assert.equal(reportDraftState({ ...event, senderFrame: { url: origin + '/' } }, window, origin, [false], guard), false);
  event.senderFrame.url = 'https://flusso.stream/';
  assert.equal(reportDraftState(event, window, origin, [false], guard), false);
  assert.deepEqual(reports, []);
  event.senderFrame.url = origin + '/';
  assert.equal(reportDraftState(event, window, origin, [true], guard), true);
  assert.equal(reportDraftState(event, window, origin, [false], guard), true);
  assert.deepEqual(reports, [true, false]);
});

test('unknown or dirty native exit cancellation keeps every runtime safety callback untouched', async () => {
  let allow = false;
  const confirmations = [], effects = [], runtime = { listener: true, server: true, model: true, store: true };
  const guard = createDraftExitGuard({ confirmDiscard: async (reason, unknown) => { confirmations.push([reason, unknown]); return allow; } });
  const shutdown = async () => { for (const part of Object.keys(runtime)) { effects.push(part); runtime[part] = false; } };
  assert.equal(await guard.run('quit', shutdown), false);
  assert.deepEqual(confirmations, [['quit', true]]);
  assert.equal(guard.isApproved(), false);
  guard.reportDirty(true);
  assert.equal(await guard.run('quit', shutdown), false);
  assert.deepEqual(effects, []);
  assert.ok(Object.values(runtime).every(Boolean));
  allow = true;
  assert.equal(await guard.run('quit', shutdown), true);
  assert.deepEqual(effects, ['listener', 'server', 'model', 'store']);
  assert.equal(guard.isApproved(), true);
  guard.reportDirty(true);
  assert.equal(guard.isApproved(), false, 'New writing invalidates exit permission.');
  allow = false;
  assert.equal(await guard.run('restart', async () => assert.fail('Cancel cannot start another shutdown.')), false);
});

test('clean reports avoid prompting, while renderer loss and failed exit work reset approval', async () => {
  let prompts = 0;
  const guard = createDraftExitGuard({ confirmDiscard: async () => { prompts++; return false; } });
  guard.reportDirty(false);
  assert.equal(await guard.run('quit', async () => {}), true);
  assert.equal(prompts, 0);
  guard.invalidate();
  assert.equal(guard.isApproved(), false);
  assert.equal(await guard.run('quit', async () => assert.fail('Unknown cancelled renderer state must stop exit.')), false);
  assert.equal(prompts, 1);
  guard.reportDirty(false);
  await assert.rejects(guard.run('restart', async () => { throw new Error('Synthetic preparation failure'); }), /preparation failure/);
  assert.equal(guard.isApproved(), false);
});

test('concurrent native exits cannot run competing quit and update side effects', async () => {
  let answer, prompts = 0, effects = 0;
  const guard = createDraftExitGuard({ confirmDiscard: () => { prompts++; return new Promise(resolve => { answer = resolve; }); } });
  guard.reportDirty(true);
  const first = guard.run('quit', async () => { effects++; });
  assert.equal(await guard.run('restart', async () => assert.fail('Competing exit must not change update settings.')), false);
  answer(false); assert.equal(await first, false);
  assert.equal(prompts, 1); assert.equal(effects, 0);
  const retry = guard.run('quit', async () => { effects++; });
  answer(true); assert.equal(await retry, true);
  assert.equal(prompts, 2); assert.equal(effects, 1);
});
