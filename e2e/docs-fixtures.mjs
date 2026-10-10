// A synthetic CV as PDF, DOCX and TXT, plus a malformed PDF and a .docx that is not
// a zip, for the document reader's tests and Task 3's smoke. Every byte is written
// here (a tiny PDF writer with text objects only, a minimal zip): nobody's real CV.
//
// Usage: node e2e/docs-fixtures.mjs   → e2e/fixtures/docs/*

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = join(HERE, 'fixtures', 'docs');

export const KNOWN_SENTENCE = 'Led the migration of the payments platform from a monolith to event-driven services, cutting checkout failures by 40%.';

export const CV_PAGES = [
  [
    'Laura Gómez Restrepo',
    'Senior Backend Engineer - Bogotá, Colombia',
    '',
    'Summary',
    'Backend engineer with nine years of experience building payment and logistics systems.',
    'Comfortable leading small teams and talking to clients in English and Spanish.',
    '',
    'Experience',
    'Acme Pay (2021-2024) - Tech Lead',
    KNOWN_SENTENCE,
    'Mentored four engineers and ran the weekly architecture review.',
    '',
    'Rutas SAS (2017-2021) - Backend Engineer',
    'Built the route optimisation API used by 300 delivery drivers every day.',
  ],
  [
    'Skills',
    'Databases: PostgreSQL, MySQL, Redis and a little MongoDB.',
    'Languages: Go, Python, TypeScript.',
    'Cloud: AWS (ECS, SQS, RDS), Terraform, GitHub Actions.',
    '',
    'Education',
    'Systems Engineering, Universidad Nacional de Colombia (2015).',
    '',
    'Languages',
    'Spanish (native), English (B2, improving my speaking for interviews).',
  ],
];

export const cvText = () => CV_PAGES.map((page) => page.join('\n')).join('\n\n');

// Lines are wrapped as a word processor would: pdf.js drops text set beyond the
// page edge, so an unwrapped 115-character line lost its last words (measured).
function wrap(line, width = 85) {
  const out = [];
  let cur = '';
  for (const word of line.split(' ')) {
    if (cur && cur.length + 1 + word.length > width) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  out.push(cur);
  return out;
}

// Helvetica with WinAnsiEncoding, one Tj per line: Latin-1 bytes carry the accents.
export function cvPdf(pages = CV_PAGES) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const lines of pages) {
    const ops = ['BT', '/F1 11 Tf', '14 TL', '56 780 Td'];
    for (const line of lines.flatMap((l) => wrap(l))) ops.push(line ? `(${esc(line)}) Tj T*` : 'T*');
    ops.push('ET');
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A minimal zip: local headers, central directory, end record. `store` keeps an
// entry uncompressed (method 0); otherwise it is deflated (method 8).
export function zip(entries, { store = [] } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content);
    const stored = store.includes(name);
    const data = stored ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xmlEsc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Each line a paragraph; a line's text is cut into two runs, as Word does when the
// formatting changes mid-sentence, so the reader has to join runs.
export function documentXml(lines) {
  const paragraphs = lines.map((line) => {
    if (!line) return '<w:p/>';
    const cut = Math.floor(line.length / 2);
    const run = (t) => `<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`;
    return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${run(line.slice(0, cut))}${run(line.slice(cut))}</w:p>`;
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${paragraphs.join('')}<w:sectPr/></w:body></w:document>`;
}

export function cvDocx(lines = CV_PAGES.flatMap((page, i) => (i ? ['', ...page] : page)), options) {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': documentXml(lines),
  }, options);
}

export const malformedPdf = () => Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R\nthis is not a PDF any more\n', 'latin1');
export const notZipDocx = () => Buffer.from('This is plain text with a .docx name.\n', 'utf8');

export function writeDocsFixtures(dir = DOCS_DIR) {
  mkdirSync(dir, { recursive: true });
  const files = {
    'cv.pdf': cvPdf(),
    'cv.docx': cvDocx(),
    'cv.txt': Buffer.from(cvText(), 'utf8'),
    'malformed.pdf': malformedPdf(),
    'not-a-zip.docx': notZipDocx(),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return Object.keys(files).map((name) => join(dir, name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const path of writeDocsFixtures()) console.log(path);
}
