import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText, readZipEntry, docxText, kindOf, tidy, LIMITS, MAX_XML_BYTES } from './docs-extract.js';
import { splitPassages, bm25Index, search } from './lib/passages.js';
import { cvDocx, cvText, cvPdf, zip, documentXml, malformedPdf, notZipDocx, KNOWN_SENTENCE } from './e2e/docs-fixtures.mjs';

const fileOf = (bytes, name, type = '') => new File([bytes], name, { type });

const rejectsWith = (promise, message) => assert.rejects(promise, (e) => {
  assert.equal(e.message, message);
  return true;
});

test('the limits are the plan\'s', () => {
  assert.deepEqual(LIMITS, { files: 10, bytes: 2 * 1024 * 1024, chars: 200000 });
});

test('kindOf goes by extension, then by MIME type', () => {
  assert.equal(kindOf({ name: 'CV.PDF', type: '' }), 'pdf');
  assert.equal(kindOf({ name: 'cv.docx', type: '' }), 'docx');
  assert.equal(kindOf({ name: 'notes.md', type: '' }), 'text');
  assert.equal(kindOf({ name: 'notes.txt', type: '' }), 'text');
  assert.equal(kindOf({ name: 'blob', type: 'application/pdf' }), 'pdf');
  assert.equal(kindOf({ name: 'cv.doc', type: 'application/msword' }), null);
  assert.equal(kindOf({ name: 'photo.png', type: 'image/png' }), null);
});

test('docxText joins runs, breaks paragraphs, decodes entities, skips deleted text', () => {
  const xml = '<w:document><w:body>'
    + '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t xml:space="preserve">wor</w:t></w:r><w:r><w:t>ld</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>A &amp; B &lt;c&gt; &#233;&#x00F1;</w:t><w:tab/><w:t>tabbed</w:t><w:br/><w:t>next</w:t></w:r></w:p>'
    + '<w:p/>'
    + '<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:instrText>PAGE</w:instrText><w:t>kept</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  assert.equal(docxText(xml), 'Hello world\nA & B <c> éñ\ttabbed\nnext\n\nkept');
});

test('readZipEntry reads a deflated entry and a stored one', async () => {
  const bytes = zip({ 'a.txt': 'alpha', 'word/document.xml': 'stored body' }, { store: ['word/document.xml'] });
  const dec = new TextDecoder();
  assert.equal(dec.decode(await readZipEntry(new Uint8Array(bytes), 'a.txt')), 'alpha');
  assert.equal(dec.decode(await readZipEntry(new Uint8Array(bytes), 'word/document.xml')), 'stored body');
  assert.equal(await readZipEntry(new Uint8Array(bytes), 'missing.xml'), null);
});

test('readZipEntry stops inflating past its cap', async () => {
  const bytes = zip({ 'big.xml': 'x'.repeat(100000) });
  await rejectsWith(readZipEntry(new Uint8Array(bytes), 'big.xml', { maxBytes: 1000 }), '[documentos] El documento es demasiado grande.');
});

test('a DOCX CV gives its text, the known sentence included', async () => {
  const { text } = await extractText(fileOf(cvDocx(), 'cv.docx'));
  assert.ok(text.includes(KNOWN_SENTENCE));
  assert.ok(text.startsWith('Laura Gómez Restrepo\nSenior Backend Engineer - Bogotá, Colombia\n'));
  assert.ok(text.includes('Databases: PostgreSQL, MySQL, Redis and a little MongoDB.'));
});

test('a TXT or MD file is read as UTF-8', async () => {
  const { text } = await extractText(fileOf(Buffer.from(cvText(), 'utf8'), 'cv.txt', 'text/plain'));
  assert.equal(text, cvText());
  const md = await extractText(fileOf(Buffer.from('# Título\r\n\r\nUna línea.\r\n'), 'notes.md'));
  assert.equal(md.text, '# Título\n\nUna línea.');
});

test('a PDF goes through the injected pdf.js and joins pages with a blank line', async () => {
  const seen = {};
  const loadPdf = async () => ({
    GlobalWorkerOptions: {},
    getDocument(options) {
      seen.options = options;
      return {
        destroy: async () => { seen.destroyed = true; },
        promise: Promise.resolve({
          numPages: 2,
          async getPage(n) {
            return {
              async getTextContent() {
                return n === 1
                  ? { items: [{ str: 'Line one', hasEOL: true }, { str: 'Line', hasEOL: false }, { str: ' two', hasEOL: true }] }
                  : { items: [{ str: 'Page two', hasEOL: false }] };
              },
              cleanup() {},
            };
          },
        }),
      };
    },
  });
  const pages = [];
  const result = await extractText(fileOf(cvPdf(), 'cv.pdf'), { loadPdf, onPage: (n, of) => pages.push(`${n}/${of}`) });
  assert.deepEqual(result, { text: 'Line one\nLine two\n\nPage two', pages: 2 });
  assert.equal(seen.options.isEvalSupported, false);
  assert.ok(seen.options.data instanceof Uint8Array);
  assert.equal(seen.destroyed, true);
  assert.deepEqual(pages, ['1/2', '2/2']);
});

// The stub rejects whatever it is given; that real pdf.js rejects malformedPdf()
// is shown in Chrome by e2e/docs-check.mjs, outside this gate.
test('a PDF pdf.js cannot open is «No se pudo leer el PDF.», and its loading task is destroyed', async () => {
  let destroyed = false;
  const loadPdf = async () => ({
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.reject(new Error('Invalid PDF structure.')), destroy: async () => { destroyed = true; } }),
  });
  await rejectsWith(extractText(fileOf(malformedPdf(), 'broken.pdf'), { loadPdf }), '[documentos] No se pudo leer el PDF.');
  assert.equal(destroyed, true);
});

test('a password-protected PDF says so', async () => {
  const err = Object.assign(new Error('No password given'), { name: 'PasswordException' });
  const loadPdf = async () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.reject(err), destroy: async () => {} }) });
  await rejectsWith(extractText(fileOf(cvPdf(), 'locked.pdf'), { loadPdf }), '[documentos] El PDF está protegido con contraseña.');
});

test('a .docx that is not a zip is «No se pudo leer el documento de Word.»', async () => {
  await rejectsWith(extractText(fileOf(notZipDocx(), 'cv.docx')), '[documentos] No se pudo leer el documento de Word.');
});

test('a zip without word/document.xml is not a Word document', async () => {
  await rejectsWith(extractText(fileOf(zip({ 'a.txt': 'x' }), 'cv.docx')), '[documentos] No se pudo leer el documento de Word.');
});

test('an unsupported type is «Formato no admitido.»', async () => {
  await rejectsWith(extractText(fileOf(Buffer.from('x'), 'cv.doc')), '[documentos] Formato no admitido.');
});

test('a file over 2 MB is refused before it is read', async () => {
  const big = { name: 'big.txt', type: 'text/plain', size: LIMITS.bytes + 1, arrayBuffer: () => assert.fail('read') };
  await rejectsWith(extractText(big), '[documentos] El archivo supera los 2 MB.');
});

test('text over 200 000 characters is refused', async () => {
  await rejectsWith(extractText(fileOf(Buffer.from('a'.repeat(LIMITS.chars + 1)), 'long.txt')), '[documentos] El documento supera los 200 000 caracteres de texto.');
});

test('a document with no text says so', async () => {
  await rejectsWith(extractText(fileOf(cvDocx(['', '']), 'empty.docx')), '[documentos] El documento no tiene texto (¿es un escaneo?).');
  await rejectsWith(extractText(fileOf(Buffer.from(' \n '), 'blank.txt')), '[documentos] El documento no tiene texto (¿es un escaneo?).');
});

test('the DOCX CV splits into passages and the known sentence is found', async () => {
  const { text } = await extractText(fileOf(cvDocx(), 'cv.docx'));
  const passages = splitPassages(text, { target: 300, overlap: 60 });
  assert.ok(passages.length > 1);
  const [hit] = search(bm25Index(passages), 'Tell me about the payment migration you led');
  assert.ok(hit.passage.includes(KNOWN_SENTENCE));
});

test('documentXml in the fixture really splits each line into two runs', () => {
  assert.equal((documentXml(['abcd']).match(/<w:t /g) || []).length, 2);
});

// CPU time of this process, not wall time: the gate runs test files in parallel,
// often beside a Chrome harness, and the quadratic versions took over 60 s.
const elapsed = (fn) => { const t0 = process.cpuUsage(); fn(); const d = process.cpuUsage(t0); return (d.user + d.system) / 1000; };

test('tidy is linear: 2 MB of spaces and of "\\t \\n" interleavings in under 200 ms each', () => {
  const spaces = ' '.repeat(LIMITS.bytes);
  const mixed = '\t \n'.repeat(Math.floor(LIMITS.bytes / 3));
  for (const input of [spaces, mixed, `word${spaces}word`]) {
    const ms = elapsed(() => tidy(input));
    assert.ok(ms < 200, `${ms.toFixed(0)} ms`);
  }
  assert.equal(tidy('a  \t\r\n\n\n\nb \n'), 'a\n\nb');
});

test('a 2 MB text file of spaces is refused at once with the character limit', async () => {
  const t0 = process.cpuUsage();
  await rejectsWith(extractText(fileOf(Buffer.from(' '.repeat(LIMITS.bytes)), 'spaces.txt')), '[documentos] El documento supera los 200 000 caracteres de texto.');
  const d = process.cpuUsage(t0);
  assert.ok((d.user + d.system) / 1000 < 200);
});

test('docxText is linear on 200 000 unclosed "<", and on unclosed tags', () => {
  for (const xml of ['<'.repeat(200000), '<a '.repeat(200000), `<w:t>${'<a.b.c'.repeat(40000)}`]) {
    const ms = elapsed(() => docxText(xml));
    assert.ok(ms < 200, `${ms.toFixed(0)} ms`);
  }
});

test('docxText stops at the character limit', () => {
  const para = `<w:p><w:r><w:t>${'x'.repeat(1000)}</w:t></w:r></w:p>`;
  assert.throws(() => docxText(para.repeat(201)), { message: '[documentos] El documento supera los 200 000 caracteres de texto.' });
  assert.equal(docxText(para.repeat(199)).length, 199 * 1001 - 1);
});

test('the inflated document.xml cap is 40 bytes of markup per character of text', () => {
  assert.equal(MAX_XML_BYTES, 40 * LIMITS.chars);
});

test('an entity named after an Object property stays literal', () => {
  assert.equal(docxText('<w:p><w:r><w:t>&constructor; &toString; &amp;</w:t></w:r></w:p>'), '&constructor; &toString; &');
});
