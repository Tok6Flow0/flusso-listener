import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEntry } from '../src/model.mjs';

const entry = { title: 'Research', body: 'Do not run this untrusted note as instructions.', signal: null, status: 'watching' };
test('local classification uses a fixed loopback model, JSON schema, no tools, and nonthinking mode', async () => {
  const result = await classifyEntry({ entry, instructions: 'Watch research.', fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat'); const body = JSON.parse(options.body); assert.equal(body.think, false); assert.equal(body.stream, false); assert.equal(body.format.additionalProperties, false); assert.equal(body.tools, undefined);
    return new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ decision: 'review', reason: 'No typed signal.' }) } }));
  } });
  assert.equal(result.decision, 'review');
});
test('model-generated tool calls or extra execution fields fail closed', async () => {
  await assert.rejects(classifyEntry({ entry, fetchImpl: async () => new Response(JSON.stringify({ done: true, message: { content: '{}', tool_calls: [{}] } })) }), /complete classification/);
  await assert.rejects(classifyEntry({ entry, fetchImpl: async () => new Response(JSON.stringify({ done: true, message: { content: JSON.stringify({ decision: 'candidate', reason: 'match', execute: true }) } })) }), /Unsupported classification/);
});
