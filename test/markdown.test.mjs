import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, renderMarkdown } from '../public/markdown.mjs';

test('Journal article parsing preserves heading, paragraphs, lists, fences and tables', () => {
  const blocks = parseMarkdown('## Research\n\nA **bold** observation.\n\n- First\n- Second\n\n| Asset | Amount |\n| --- | ---: |\n| BTC | 10 |\n\n```json\n{"observation":true}\n```');
  assert.deepEqual(blocks.map(row => row.type), ['h2', 'p', 'ul', 'table', 'code']); assert.equal(blocks[2].items.length, 2); assert.deepEqual(blocks[3].rows[0], ['BTC', '10']);
});
test('HTML and remote image syntax stay inert text rather than becoming HTML blocks', () => {
  const text = '<script>globalThis.injected=true</script>\n<img src="https://example.com/track">\n![image](https://example.com/track)';
  const blocks = parseMarkdown(text); assert.equal(blocks.length, 1); assert.equal(blocks[0].type, 'p'); assert.match(blocks[0].text, /<script>/);
});
test('a source H1 renders as an in-article section heading while preserving its title and inert HTML boundary', () => {
  const blocks = parseMarkdown('# Findings\n\n## Evidence\n\n### Source\n\n# <script>unchanged text</script>');
  assert.deepEqual(blocks.map(block => block.type), ['h2', 'h2', 'h3', 'h2']);
  assert.equal(blocks[0].text, 'Findings'); assert.equal(blocks[3].text, '<script>unchanged text</script>');
  assert.ok(!blocks.some(block => block.type === 'h1'), 'Journal retains its one page title.');
});
test('rendered ISO dates and signed decimals preserve exact prose and leave sentence punctuation outside numeric spans', () => {
  const previous = globalThis.document;
  const element = tag => ({ tag, children: [], value: '', append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; this.value = ''; },
    get textContent() { return this.value + this.children.map(node => node.textContent).join(''); }, set textContent(value) { this.value = value; this.children = []; } });
  globalThis.document = { createElement: element, createTextNode: textContent => ({ textContent }) };
  try {
    const heading = element('article'); renderMarkdown(heading, '# Findings'); assert.equal(heading.children[0].tag, 'h2'); assert.equal(heading.textContent, 'Findings');
    const prose = 'Recorded 2026-10-20. At 2026-10-20T14:03:05.250Z, rates were -12.50bps, +3%, and 1,234.56.';
    const root = element('article'); renderMarkdown(root, prose); assert.equal(root.textContent, prose);
    const walk = node => [node, ...(node.children ?? []).flatMap(walk)];
    assert.deepEqual(walk(root).filter(node => node.className === 'mono').map(node => node.textContent), ['2026-10-20', '2026-10-20T14:03:05.250Z', '-12.50bps', '+3%', '1,234.56']);
    assert.ok(root.children[0].children.some(node => node.textContent === '. At '), 'A period following a date remains ordinary punctuation.');
    const hyphens = 'COVID-19 takes 2-3 days or 2–3 days; the recorded changes were -12.50bps and −3%.';
    renderMarkdown(root, hyphens); assert.equal(root.textContent, hyphens);
    assert.deepEqual(walk(root).filter(node => node.className === 'mono').map(node => node.textContent), ['19', '2', '3', '2', '3', '-12.50bps', '−3%']);
  } finally { globalThis.document = previous; }
});
