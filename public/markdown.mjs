// Adapted from Flusso StudioMarkdown: the same deliberately small Markdown subset.
// DOM text nodes only. HTML, remote images and external links are never executed.
const splitRow = line => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
const delimiter = line => splitRow(line).every(cell => /^:?-+:?$/.test(cell));
export function parseMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n'), blocks = [];
  let paragraph = [], list = null;
  const flush = () => { if (paragraph.length) { blocks.push({ type: 'p', text: paragraph.join(' ') }); paragraph = []; } if (list) { blocks.push(list); list = null; } };
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed) { flush(); continue; }
    if (/^```[^\s`]*\s*$/.test(trimmed)) {
      flush(); const code = []; let cursor = index + 1;
      while (cursor < lines.length && !/^```\s*$/.test(lines[cursor].trim())) code.push(lines[cursor++]);
      blocks.push({ type: 'code', text: code.join('\n') }); index = Math.min(cursor, lines.length - 1); continue;
    }
    const next = lines[index + 1]?.trim() ?? '';
    if (trimmed.includes('|') && next.includes('|') && delimiter(next)) {
      flush(); const head = splitRow(trimmed), rows = []; let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes('|')) { const row = splitRow(lines[cursor++]); while (row.length < head.length) row.push(''); rows.push(row.slice(0, head.length)); }
      blocks.push({ type: 'table', head, rows }); index = cursor - 1; continue;
    }
    const heading = /^(#{2,3})\s+(.+)$/.exec(trimmed);
    if (heading) { flush(); blocks.push({ type: `h${heading[1].length}`, text: heading[2] }); continue; }
    const unordered = /^[-*•]\s+(.+)$/.exec(trimmed), ordered = /^(\d+)[.)]\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      if (paragraph.length) { blocks.push({ type: 'p', text: paragraph.join(' ') }); paragraph = []; }
      const type = unordered ? 'ul' : 'ol'; if (list?.type !== type) { if (list) blocks.push(list); list = { type, items: [] }; }
      list.items.push({ text: unordered?.[1] ?? ordered[2], value: ordered ? Number(ordered[1]) : null }); continue;
    }
    if (list) { blocks.push(list); list = null; } paragraph.push(trimmed);
  }
  flush(); return blocks;
}
function plain(parent, text) {
  for (const part of text.split(/(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?|(?<![\p{L}\p{N}])[+\-−]\d+(?:[,.]\d+)*(?:%|bps)?|\d+(?:[,.]\d+)*(?:%|bps)?)/gu)) {
    if (!part) continue;
    if (/^[+\-−]?\d/.test(part)) { const span = document.createElement('span'); span.className = 'mono'; span.textContent = part; parent.append(span); }
    else parent.append(document.createTextNode(part));
  }
}
function inline(parent, text) {
  let last = 0; const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g; let match;
  while ((match = pattern.exec(text))) {
    plain(parent, text.slice(last, match.index));
    const tag = match[0].startsWith('**') ? 'strong' : 'code', node = document.createElement(tag);
    if (tag === 'code') node.textContent = match[0].slice(1, -1); else plain(node, match[0].slice(2, -2));
    parent.append(node); last = match.index + match[0].length;
  }
  plain(parent, text.slice(last));
}
export function renderMarkdown(parent, markdown) {
  parent.replaceChildren();
  for (const block of parseMarkdown(markdown)) {
    if (block.type === 'table') {
      const wrap = document.createElement('div'); wrap.className = 'table-scroll'; const table = document.createElement('table');
      const head = document.createElement('thead'), tr = document.createElement('tr'); for (const cell of block.head) { const th = document.createElement('th'); inline(th, cell); tr.append(th); } head.append(tr); table.append(head);
      const body = document.createElement('tbody'); for (const row of block.rows) { const line = document.createElement('tr'); for (const cell of row) { const td = document.createElement('td'); if (/^[+\-−]?[$€£]?\d[\d,._\s]*(?:[KMBT]|%|bps)?$/i.test(cell.trim())) td.className = 'numeric'; inline(td, cell); line.append(td); } body.append(line); } table.append(body); wrap.append(table); parent.append(wrap); continue;
    }
    if (block.type === 'code') { const wrap = document.createElement('div'); wrap.className = 'code-scroll'; const pre = document.createElement('pre'); pre.textContent = block.text; wrap.append(pre); parent.append(wrap); continue; }
    const node = document.createElement(block.type);
    if (block.items) for (const item of block.items) { const li = document.createElement('li'); if (item.value != null) li.value = item.value; inline(li, item.text); node.append(li); }
    else inline(node, block.text);
    parent.append(node);
  }
}
