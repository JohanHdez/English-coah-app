// Text out of the learner's documents, on the device: PDF through the vendored
// pdf.js, Word by reading word/document.xml out of the zip, plain text as UTF-8.
// Nothing here uploads, and nothing in a document is ever executed or rendered.

export const LIMITS = { files: 10, bytes: 2 * 1024 * 1024, chars: 200000 };

// word/document.xml wraps every run of text in markup (run and paragraph properties,
// revision ids); 40 bytes of XML per character of text, 8 MB at the 200 000-character
// limit, is several times the overhead of a heavily formatted document (an estimate,
// not a measurement), and a zip bomb stops here instead of filling the tab's memory.
export const MAX_XML_BYTES = 40 * LIMITS.chars;

export class DocumentError extends Error {
  constructor(message) {
    super(`[documentos] ${message}`);
    this.name = 'DocumentError';
  }
}

const UNSUPPORTED = 'Formato no admitido.';
const BAD_PDF = 'No se pudo leer el PDF.';
const BAD_DOCX = 'No se pudo leer el documento de Word.';

export function kindOf(file) {
  const ext = /\.([a-z0-9]+)$/i.exec(file?.name || '')?.[1]?.toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'txt' || ext === 'md' || ext === 'markdown') return 'text';
  if (ext) return null;
  const type = file?.type || '';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (type === 'text/plain' || type === 'text/markdown') return 'text';
  return null;
}

const isBlank = (c) => c <= 32 || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
  || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

// Trailing whitespace off every line, at most one blank line in a row, none at the
// ends, in one pass that only slices lines with text. /[ \t]+\n/ backtracked over
// every start in a run of spaces with no line break after it (80 000 spaces took
// 9.4 s, measured), and split/map/join over 700 000 short lines cost 300 ms of CPU.
export function tidy(text) {
  const s = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
  const parts = [];
  let breaks = 0;
  for (let i = 0; i <= s.length;) {
    let end = s.indexOf('\n', i);
    if (end < 0) end = s.length;
    let last = end;
    while (last > i && isBlank(s.charCodeAt(last - 1))) last--;
    if (last > i) {
      let first = i;
      if (!parts.length) while (isBlank(s.charCodeAt(first))) first++;
      if (parts.length) parts.push(breaks > 1 ? '\n\n' : '\n');
      parts.push(s.slice(first, last));
      breaks = 0;
    }
    breaks++;
    i = end + 1;
  }
  return parts.join('');
}

async function inflateRaw(data, maxBytes) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new DocumentError('El documento es demasiado grande.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Sizes and offsets come from the central directory, since a writer that streams
// (bit 3) leaves them zero in the local header; the data starts after the local
// header's own name and extra field, whose lengths can differ from the central one's.
export async function readZipEntry(bytes, name, { maxBytes = MAX_XML_BYTES } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, true);
  const u32 = (at) => view.getUint32(at, true);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new DocumentError(BAD_DOCX);
  const count = u16(end + 10);
  let at = u32(end + 16);
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(at) !== 0x02014b50) throw new DocumentError(BAD_DOCX);
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const size = u32(at + 20);
    const nameLen = u16(at + 28);
    const local = u32(at + 42);
    const entryName = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + u16(at + 30) + u16(at + 32);
    if (entryName !== name) continue;
    if (flags & 1) throw new DocumentError(BAD_DOCX);
    if (local + 30 > bytes.length || u32(local) !== 0x04034b50) throw new DocumentError(BAD_DOCX);
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + size > bytes.length) throw new DocumentError(BAD_DOCX);
    const data = bytes.subarray(start, start + size);
    if (method === 0) {
      if (data.length > maxBytes) throw new DocumentError('El documento es demasiado grande.');
      return data;
    }
    if (method === 8) return inflateRaw(data, maxBytes);
    throw new DocumentError(BAD_DOCX);
  }
  return null;
}

const ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES.get(e) ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

// Only <w:t> text is kept: deleted revisions (<w:delText>) and field codes
// (<w:instrText>) are markup a reader of the document never sees. A tag's body
// cannot cross '<', and a stray '<' is consumed alone, so an unclosed '<' costs
// the distance to the next one, never the rest of the file.
export function docxText(xml) {
  let out = '';
  let inText = false;
  for (const [, close, tag, self, text] of xml.matchAll(/<(\/?)([A-Za-z][\w.:-]*)(?=[\s/>])[^<>]*?(\/?)>|([^<]+)|</g)) {
    if (text !== undefined) {
      if (inText) out += decodeEntities(text);
      if (out.length > LIMITS.chars) throw tooLong();
      continue;
    }
    if (tag === 'w:t') inText = !close && !self;
    else if (tag === 'w:p' && (close || self)) out += '\n';
    else if (tag === 'w:tab' && !close) out += '\t';
    else if ((tag === 'w:br' || tag === 'w:cr') && !close) out += '\n';
  }
  return tidy(out);
}

async function loadPdfjs() {
  const pdfjs = await import(new URL('./vendor/pdfjs/pdf.min.mjs', import.meta.url).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

function tooLong() {
  const n = String(LIMITS.chars).replace(/\B(?=(\d{3})+$)/g, ' ');
  return new DocumentError(`El documento supera los ${n} caracteres de texto.`);
}

async function pdfText(bytes, { loadPdf, onPage }) {
  let task;
  try {
    const pdfjs = await loadPdf();
    task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
    const doc = await task.promise;
    const pages = [];
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      const text = items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('');
      page.cleanup?.();
      chars += text.length;
      if (chars > LIMITS.chars) throw tooLong();
      pages.push(tidy(text));
      onPage?.(n, doc.numPages);
    }
    return { text: tidy(pages.join('\n\n')), pages: doc.numPages };
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    throw new DocumentError(e?.name === 'PasswordException' ? 'El PDF está protegido con contraseña.' : BAD_PDF);
  } finally {
    // The loading task owns the worker; destroying it frees the document too.
    if (task) await task.destroy().catch(() => {});
  }
}

async function docxFileText(bytes) {
  let xml;
  try {
    xml = await readZipEntry(bytes, 'word/document.xml');
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    throw new DocumentError(BAD_DOCX);
  }
  if (!xml) throw new DocumentError(BAD_DOCX);
  return { text: docxText(new TextDecoder().decode(xml)) };
}

function plainText(bytes) {
  const raw = new TextDecoder('utf-8').decode(bytes);
  if (raw.length > LIMITS.chars) throw tooLong();
  return { text: tidy(raw) };
}

// onPage(n, of) reports PDF progress, for «Leyendo… N páginas».
export async function extractText(file, { loadPdf = loadPdfjs, onPage } = {}) {
  const kind = kindOf(file);
  if (!kind) throw new DocumentError(UNSUPPORTED);
  if (file.size > LIMITS.bytes) throw new DocumentError('El archivo supera los 2 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = kind === 'pdf' ? await pdfText(bytes, { loadPdf, onPage })
    : kind === 'docx' ? await docxFileText(bytes)
      : plainText(bytes);
  if (result.text.length > LIMITS.chars) throw tooLong();
  if (!result.text.trim()) throw new DocumentError('El documento no tiene texto (¿es un escaneo?).');
  return result;
}
