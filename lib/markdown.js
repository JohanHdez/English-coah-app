// A deliberately tiny Markdown subset for the model's report: headings, bullet and
// numbered lists, **bold** and paragraphs. parseMarkdown is pure; renderMarkdown
// builds nodes with createElement/createTextNode only, so every value is text by
// construction and HTML in the input shows up literally.

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

export function parseInline(text) {
  const parts = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), bold: false });
    parts.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold: false });
  return parts;
}

export function parseMarkdown(md) {
  const lines = String(md ?? '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = line.match(HEADING);
    if (heading) {
      // The page's own title is the h1, so the report starts at h2.
      blocks.push({ type: 'heading', level: Math.max(2, heading[1].length), inline: parseInline(heading[2].trim()) });
      i++;
      continue;
    }
    const kind = BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : null;
    if (kind) {
      const marker = kind === 'ul' ? BULLET : NUMBERED;
      const items = [];
      while (i < lines.length && marker.test(lines[i])) { items.push(parseInline(lines[i].replace(marker, '').trim())); i++; }
      blocks.push({ type: kind, items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'p', inline: parseInline(para.join(' ')) });
  }
  return blocks;
}

function appendInline(doc, parent, parts) {
  for (const part of parts) {
    if (part.bold) {
      const b = doc.createElement('strong');
      b.textContent = part.text;
      parent.append(b);
    } else {
      parent.append(doc.createTextNode(part.text));
    }
  }
}

export function renderMarkdown(md, doc = document) {
  const out = doc.createDocumentFragment();
  for (const block of parseMarkdown(md)) {
    if (block.type === 'ul' || block.type === 'ol') {
      const list = doc.createElement(block.type);
      for (const item of block.items) {
        const li = doc.createElement('li');
        appendInline(doc, li, item);
        list.append(li);
      }
      out.append(list);
    } else {
      const node = doc.createElement(block.type === 'heading' ? `h${block.level}` : 'p');
      appendInline(doc, node, block.inline);
      out.append(node);
    }
  }
  return out;
}
