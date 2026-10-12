import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedFrame, externalUrl } from '../desktop/policy.mjs';

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
