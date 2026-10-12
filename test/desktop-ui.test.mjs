import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPresentation, updatePresentation, modelPresentation } from '../public/desktop-ui.mjs';

test('account identity comes only from a connected account profile', () => {
  assert.equal(accountPresentation({ connected: false, profile: { displayName: 'Old identity', email: 'old@example.test' } }).name, 'Local workspace');
  assert.deepEqual(accountPresentation({ connected: true, profile: { displayName: '  Sam  ', email: 'sam@example.test' } }), { name: 'Sam', detail: 'sam@example.test', initial: 'S', connected: true });
  assert.equal(accountPresentation({ connected: true }).name, 'Connected account');
  assert.equal(accountPresentation({ connected: true, profile: { displayName: 42 } }).name, 'Connected account');
});

test('update download and installation are separate explicit actions', () => {
  assert.equal(updatePresentation({ state: 'available', version: '0.2.0' }).action, 'downloadUpdate');
  assert.equal(updatePresentation({ state: 'downloaded' }).action, 'installUpdate');
  for (const state of ['idle', 'checking', 'downloading', 'current', 'unsupported', 'unrecognized']) assert.equal(updatePresentation({ state }).action, null);
  assert.equal(updatePresentation({ state: 'error' }).action, 'checkUpdates');
  assert.equal(updatePresentation({ state: 'unsupported' }).visible, false);
  assert.equal(updatePresentation({ state: 'current' }).visible, false);
});

test('progress is shown only when the native bridge reports a valid percentage', () => {
  for (const value of [undefined, null, '50', NaN, Infinity, -1, 101]) {
    assert.equal(updatePresentation({ state: 'downloading', percent: value }).percent, null);
    assert.equal(modelPresentation({ state: 'installing', percent: value }).percent, null);
  }
  for (const value of [0, 12.5, 100]) assert.equal(updatePresentation({ state: 'downloading', percent: value }).percent, value);
});

test('model setup is optional, reports native progress, and never claims unknown readiness', () => {
  assert.equal(modelPresentation({ state: 'missing' }).label, 'Set up local model');
  assert.equal(modelPresentation({ state: 'installing' }).busy, true);
  assert.equal(modelPresentation({ state: 'ready' }).visible, false);
  assert.equal(modelPresentation({ state: 'error' }).label, 'Retry model setup');
  assert.equal(modelPresentation().visible, false);
  assert.equal(modelPresentation().busy, true);
});
