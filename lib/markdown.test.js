import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, renderMarkdown } from './markdown.js';

test('headings start at h2 and cap at four hashes', () => {
  const blocks = parseMarkdown('# Uno\n## Dos\n### Tres\n##### no');
  assert.deepEqual(blocks.slice(0, 3).map((b) => b.level), [2, 2, 3]);
  assert.equal(blocks[3].type, 'p');
});

test('bullet and numbered lists group consecutive items', () => {
  const blocks = parseMarkdown('- a\n- b\n\n1. uno\n2) dos');
  assert.equal(blocks[0].type, 'ul');
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[1].type, 'ol');
  assert.equal(blocks[1].items[1][0].text, 'dos');
});

test('bold is split out of the surrounding text', () => {
  assert.deepEqual(parseInline('a **b** c'), [
    { text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false },
  ]);
});

test('paragraph lines join; a blank line or block starts a new one', () => {
  const blocks = parseMarkdown('uno\ndos\n\ntres\n- x');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].inline[0].text, 'uno dos');
});

test('empty and missing input give no blocks', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(undefined), []);
});

test('HTML in the input stays text and never becomes a node', () => {
  const created = [];
  const node = (tag) => ({ tag, children: [], append(...c) { this.children.push(...c); }, set textContent(v) { this.children.push({ text: v }); } });
  const doc = {
    createElement: (tag) => { created.push(tag); return node(tag); },
    createTextNode: (text) => ({ text }),
    createDocumentFragment: () => node('#frag'),
  };
  renderMarkdown('## <script>alert(1)</script>\n- <img src=x onerror=alert(1)> **<b>x</b>**', doc);
  assert.deepEqual(created, ['h2', 'ul', 'li', 'strong']);
});
