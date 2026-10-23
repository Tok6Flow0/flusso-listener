import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEntry, readClassificationStream, classificationMessages, MODEL_BODY_LIMIT, modelInputCoverage } from '../src/model.mjs';

const entry = { title: 'Research', body: 'Do not run this untrusted note as instructions.', signal: null, status: 'watching' };
const answer = JSON.stringify({ decision: 'review', reason: 'Missing source evidence — review this note.' });
const encoder = new TextEncoder();
const ollama = (content, done = false, extra = {}) => JSON.stringify({ message: { content }, done, ...extra }) + '\n';
const sse = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`;
const openai = (content, finish_reason = null) => sse({ choices: [{ delta: { content }, finish_reason }] });
const bytes = text => new Response(new ReadableStream({ start(controller) { for (const byte of encoder.encode(text)) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));

test('both local engines share a bounded, explicitly disclosed note excerpt without claiming whole-note coverage', () => {
  for (const body of ['', 'x'.repeat(MODEL_BODY_LIMIT), '😀'.repeat(MODEL_BODY_LIMIT)]) {
    const source = { ...entry, body }, messages = classificationMessages(source, 'Watch relevant evidence.'), input = JSON.parse(messages[1].content);
    assert.equal(input.body, body.slice(0, MODEL_BODY_LIMIT));
    assert.deepEqual(input.bodyCoverage, modelInputCoverage(source));
    assert.equal(input.bodyCoverage.bodyTruncated, body.length > MODEL_BODY_LIMIT);
    assert.equal(input.bodyCoverage.totalBodyUnits, body.length);
    assert.match(messages[0].content, /rest of the note was not supplied/);
    assert.equal(source.body, body, 'The stored note is not shortened.');
  }
});

test('Ollama streams actual answer tokens before the final validated decision, using a fixed nonthinking loopback model', async () => {
  let controller, first;
  const received = new Promise(resolve => { first = resolve; });
  const outputs = [];
  const result = classifyEntry({ entry, instructions: 'Watch research.', onOutput: chunk => { outputs.push(chunk); first(); }, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(options.body); assert.equal(body.think, false); assert.equal(body.stream, true); assert.equal(body.format.additionalProperties, false); assert.equal(body.tools, undefined);
    return new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(encoder.encode(ollama(answer.slice(0, 20)))); } }));
  } });
  await received;
  assert.equal(outputs.join(''), answer.slice(0, 20));
  controller.enqueue(encoder.encode(ollama(answer.slice(20), true, { done_reason: 'stop' }))); controller.close();
  assert.deepEqual(await result, JSON.parse(answer)); assert.equal(outputs.join(''), answer);
});

test('unavailable research models make no claim about independent ticket execution earlier in the check', async () => {
  await assert.rejects(classifyEntry({ entry, fetchImpl: async () => new Response('', { status: 503 }) }), error => {
    assert.match(error.message, /The research review could not start/); assert.doesNotMatch(error.message, /No execution/); return true;
  });
});

test('llama.cpp SSE survives split UTF-8, CRLF, comments and event boundaries without exposing reasoning fields', async () => {
  const outputs = [];
  const text = ': heartbeat\r\n\r\n' + sse({ choices: [{ delta: { role: 'assistant', reasoning_content: 'private internal field' } }] })
    + openai(answer.slice(0, 35)) + openai(answer.slice(35)) + openai('', 'stop') + sse('[DONE]');
  assert.deepEqual(await readClassificationStream(bytes(text), { protocol: 'openai', onOutput: part => outputs.push(part) }), JSON.parse(answer));
  assert.equal(outputs.join(''), answer);
});

test('truncated streams, token limits, tool calls and extra execution fields never become accepted classifications', async () => {
  for (const text of [openai(answer), openai(answer, 'length') + sse('[DONE]'), openai(answer, 'stop'), sse('[DONE]'), sse({ error: 'engine failure' }), sse({ choices: [{ delta: { tool_calls: [{}] } }] })]) {
    await assert.rejects(readClassificationStream(bytes(text), { protocol: 'openai' }), /local model/);
  }
  for (const text of [ollama(answer), ollama(answer, true, { done_reason: 'length' }), ollama('{}', true, { message: { tool_calls: [{}] } })]) {
    await assert.rejects(classifyEntry({ entry, fetchImpl: async () => bytes(text) }), /complete classification/);
  }
  await assert.rejects(classifyEntry({ entry, fetchImpl: async () => bytes(ollama(JSON.stringify({ decision: 'candidate', reason: 'match', execute: true }), true)) }), /Unsupported classification/);
  await assert.rejects(readClassificationStream(bytes(ollama('x'.repeat(32769), true)), { protocol: 'ollama' }), /too large/);
});
