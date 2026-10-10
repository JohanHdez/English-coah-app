// Passages of the learner's documents and a BM25 search over them. Pure: no DOM,
// no storage, so it runs unmodified under node --test.

const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their', 'his',
  'her', 'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'do', 'does', 'did', 'have',
  'has', 'had', 'can', 'could', 'would', 'should', 'will', 'about', 'into', 'over', 'than', 'then',
  'so', 'not', 'no', 'yes', 'there', 'here', 'also', 'just', 'very', 'tell', 'us',
  // Spanish, accents already folded
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'pero', 'de', 'del', 'al', 'en',
  'con', 'por', 'para', 'sin', 'sobre', 'que', 'como', 'cuando', 'donde', 'quien', 'cual', 'es',
  'son', 'fue', 'era', 'ser', 'estar', 'esta', 'estan', 'ha', 'han', 'hemos', 'yo', 'tu', 'mi',
  'mis', 'te', 'se', 'nos', 'su', 'sus', 'lo', 'le', 'les', 'este', 'estos', 'estas', 'ese', 'esa',
  'eso', 'muy', 'mas', 'ya', 'tambien', 'si',
]);

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');

// A plural "s" is dropped so "databases" meets "database" and "pagos" meets "pago";
// words ending in -ss, -is, -us (Redis, status, business) keep it.
function stem(t) {
  return t.length > 3 && t.endsWith('s') && !/(ss|is|us)$/.test(t) ? t.slice(0, -1) : t;
}

export function tokenize(text) {
  const out = [];
  for (const raw of fold(String(text || '')).match(/[\p{L}\p{N}]+/gu) || []) {
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

const isBreak = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const isSpace = (c) => c === 32 || c === 9 || c === 11 || c === 12 || c === 160 || c === 0x1680
  || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

// One pass: each line break becomes \n, any other whitespace run between words one
// space, and none at a line's edges. The boundary patterns below then match single
// characters and cannot backtrack across a long run (80 000 spaces took 9.9 s with
// `\s*\n\s*`, measured); a regex replace over every run cost 120 ms on 2 MB.
function normalize(text) {
  const s = String(text || '');
  const parts = [];
  let lineStart = true;
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j < s.length && !isSpace(s.charCodeAt(j)) && !isBreak(s.charCodeAt(j))) j++;
    if (j > i) { parts.push(s.slice(i, j)); lineStart = false; }
    let k = j;
    let broke = false;
    for (; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (isBreak(c)) {
        if (!(c === 10 && s.charCodeAt(k - 1) === 13)) parts.push('\n');
        broke = true;
      } else if (!isSpace(c)) break;
    }
    if (broke) lineStart = true;
    else if (k > j && k < s.length && !lineStart) parts.push(' ');
    i = k;
  }
  return parts.join('');
}

// Coarsest boundary first: paragraphs, sentence ends, line breaks (a CV's lines
// rarely end in a full stop), then words; a word longer than the target is sliced.
const LEVELS = [/(\n{2,})/, /((?<=[.!?\u2026])[ \n])/, /(\n)/, /( )/];

// Units go into one shared array: spreading a level's units into its parent's
// (`push(...units)`) overflows the stack past about 120 000 words.
function unitsOf(text, target, out = [], level = 0, sep = '\n\n') {
  const trimmed = text.trim();
  if (!trimmed) return out;
  if (trimmed.length <= target && level > 0) {
    out.push({ text: trimmed, sep });
    return out;
  }
  if (level === LEVELS.length) {
    for (let i = 0; i < trimmed.length; i += target) out.push({ text: trimmed.slice(i, i + target), sep: i ? '' : sep });
    return out;
  }
  const parts = trimmed.split(LEVELS[level]);
  for (let i = 0; i < parts.length; i += 2) {
    const before = i === 0 ? sep : level === 0 ? '\n\n' : parts[i - 1];
    unitsOf(parts[i], target, out, level + 1, before);
  }
  return out;
}

const lengthOf = (units) => units.reduce((n, u, i) => n + u.text.length + (i ? u.sep.length : 0), 0);
const join = (units) => units.map((u, i) => (i ? u.sep + u.text : u.text)).join('');

// Paragraphs are kept whole when they fit, otherwise cut at sentence ends, and a
// sentence longer than the target between words. Each passage after the first
// opens with the last whole units of the one before, up to `overlap` characters.
export function splitPassages(text, { target = 700, overlap = 100 } = {}) {
  const passages = [];
  let cur = [];
  let len = 0;
  for (const unit of unitsOf(normalize(text), target)) {
    if (cur.length && len + unit.sep.length + unit.text.length > target) {
      passages.push(join(cur));
      const carry = [];
      for (let i = cur.length - 1; i > 0; i--) {
        if (lengthOf([cur[i], ...carry]) > overlap) break;
        carry.unshift(cur[i]);
      }
      while (carry.length && lengthOf([...carry, unit]) > target) carry.shift();
      cur = carry;
      len = lengthOf(cur);
    }
    len += (cur.length ? unit.sep.length : 0) + unit.text.length;
    cur.push(unit);
  }
  if (cur.length) passages.push(join(cur));
  return passages;
}

const textOf = (p) => (typeof p === 'string' ? p : p?.text || '');

export function bm25Index(passages, { k1 = 1.2, b = 0.75 } = {}) {
  const docs = passages.map((p) => {
    const tf = new Map();
    const tokens = tokenize(textOf(p));
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { tf, len: tokens.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgdl = docs.length ? docs.reduce((n, d) => n + d.len, 0) / docs.length : 0;
  return { passages, docs, df, avgdl, k1, b };
}

export function search(index, query, { k = 5 } = {}) {
  const { passages, docs, df, avgdl, k1, b } = index;
  const terms = [...new Set(tokenize(query))];
  const n = docs.length;
  const hits = [];
  docs.forEach((d, i) => {
    let score = 0;
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / (avgdl || 1))));
    }
    if (score > 0) hits.push({ index: i, score, passage: passages[i] });
  });
  hits.sort((x, y) => y.score - x.score || x.index - y.index);
  return hits.slice(0, k);
}
