import test from 'node:test';
import assert from 'node:assert/strict';
import { listenCallback } from '../src/browser.mjs';

test('OAuth callback rejects Unicode and duplicate state without crashing, then accepts the bound response once', async () => {
  const callback = await listenCallback({ state: 'abcd', timeoutMs: 10000 });
  try {
    assert.equal((await fetch(`${callback.redirectUri}?state=%C3%A9%C3%A9%C3%A9%C3%A9&code=x`)).status, 400);
    assert.equal((await fetch(`${callback.redirectUri}?state=abcd&state=abcd&code=x`)).status, 400);
    assert.equal((await fetch(`${callback.redirectUri}?state=abcd&code=good&iss=https%3A%2F%2Fflusso.stream`)).status, 200);
    assert.deepEqual(await callback.waitForCode, { code: 'good', state: 'abcd', issuer: 'https://flusso.stream', iss: 'https://flusso.stream', error: null });
  } finally { callback.close(); }
});
test('closing a pending OAuth callback rejects its waiter', async () => {
  const callback = await listenCallback({ state: 'close-me', timeoutMs: 10000 });
  callback.close(); await assert.rejects(callback.waitForCode, /closed/);
});
