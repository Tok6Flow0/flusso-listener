import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../public/markdown.mjs';

test('Journal article parsing preserves heading, paragraphs, lists, fences and tables', () => {
  const blocks = parseMarkdown('## Research\n\nA **bold** observation.\n\n- First\n- Second\n\n| Asset | Amount |\n| --- | ---: |\n| BTC | 10 |\n\n```json\n{"observation":true}\n```');
  assert.deepEqual(blocks.map(row => row.type), ['h2', 'p', 'ul', 'table', 'code']); assert.equal(blocks[2].items.length, 2); assert.deepEqual(blocks[3].rows[0], ['BTC', '10']);
});
test('HTML and remote image syntax stay inert text rather than becoming HTML blocks', () => {
  const text = '<script>globalThis.injected=true</script>\n<img src="https://example.com/track">\n![image](https://example.com/track)';
  const blocks = parseMarkdown(text); assert.equal(blocks.length, 1); assert.equal(blocks[0].type, 'p'); assert.match(blocks[0].text, /<script>/);
});
