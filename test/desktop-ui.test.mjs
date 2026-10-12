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

test('appearance mirrors the website palettes and resolves System from the OS', async () => {
  const { THEME_OPTIONS, resolveTheme } = await import('../public/desktop-ui.mjs');
  const { THEMES } = await import('../src/schema.mjs');
  assert.deepEqual(THEME_OPTIONS.map(option => option.mode), THEMES);
  assert.equal(resolveTheme('system', true), 'classic-dark'); assert.equal(resolveTheme('system', false), 'classic');
  assert.equal(resolveTheme('atlantic', false), 'atlantic'); assert.equal(resolveTheme('unknown', true), 'classic-dark');
});

test('activity labels say what happened to a ticket in plain words', async () => {
  const { activityStatus, entryStatus } = await import('../public/desktop-ui.mjs');
  assert.deepEqual(activityStatus({ status: 'submitted' }), { label: 'sent', tone: 'pos' });
  assert.deepEqual(activityStatus({ status: 'blocked' }), { label: 'refused', tone: 'neg' });
  assert.deepEqual(activityStatus({ status: 'observed', decision: 'candidate' }), { label: 'flagged', tone: 'info' });
  assert.equal(activityStatus({ status: 'answered' }).label, 'answered');
  assert.equal(entryStatus({ ticket: null }), null);
  assert.equal(entryStatus({ ticket: { error: 'Bad JSON' } }).tone, 'warn');
});
