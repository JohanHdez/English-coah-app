// Tells English from Spanish in a transcribed turn. Pure: no chrome.*, no DOM, no
// network — it runs in the offscreen document, in both interfaces, and in Node.
//
// It reads text, never audio, so it cannot tell Whisper which language to decode
// before the fact. What it is for is labelling a turn once the text exists, and
// deciding whether a turn was decoded in the wrong language and is worth one more
// pass.

// Function words, which is what carries the signal: they are the most frequent
// tokens in any sentence and they barely overlap between the two languages.
const ES = new Set([
  'que', 'de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'en', 'es', 'por', 'para',
  'con', 'no', 'se', 'del', 'al', 'pero', 'porque', 'como', 'más', 'este', 'esta',
  'esto', 'hay', 'ya', 'muy', 'todo', 'cuando', 'yo', 'tengo', 'vamos', 'hacer',
  'puedo', 'creo', 'entonces', 'bien', 'si', 'sí', 'ser', 'está', 'están', 'tiene',
  'sobre', 'nosotros', 'ustedes', 'también', 'ahora', 'gracias', 'perdón', 'me', 'mi',
  'su', 'lo', 'les', 'nos', 'eso', 'ese', 'algo', 'nada', 'desde', 'hasta', 'antes',
  'después', 'aquí', 'allí', 'solo', 'sólo', 'cada', 'otro', 'otra', 'mucho', 'poco',
  'vez', 'así',
]);

const EN = new Set([
  'the', 'of', 'and', 'to', 'in', 'is', 'it', 'that', 'for', 'on', 'with', 'as', 'are',
  'this', 'be', 'have', 'from', 'we', 'you', 'they', 'not', 'but', 'can', 'will',
  'would', 'i', 'my', 'our', 'your', 'so', 'what', 'when', 'there', 'think', 'about',
  'just', 'need', 'going', 'okay', 'ok', 'yes', 'thanks', 'right', 'let', 'do', 'does',
  'how', 'all', 'get', 'make', 'time', 'work', 'was', 'were', 'been', 'has', 'had',
  'at', 'by', 'if', 'or', 'then', 'them', 'these', 'those', 'should', 'could',
  'because', 'who', 'which', 'more', 'some', 'any', 'than', 'very', 'now', 'here',
  'also', 'one', 'two', 'first', 'next', 'last',
]);

// Characters English does not use in ordinary writing. Strong evidence, but scaled
// by length below rather than added flat: a single accented proper noun in an
// English sentence must not outvote its function words.
const MARKS = /[ñáéíóúü¿¡]/giu;
const MARK_WEIGHT = 0.5;

const words = (text) =>
  String(text ?? '').toLowerCase().normalize('NFC').match(/[\p{L}\p{M}']+/gu) || [];

export function detect(text) {
  const w = words(text);
  if (!w.length) return { lang: null, confidence: 0 };

  let es = 0;
  let en = 0;
  for (const word of w) {
    if (ES.has(word)) es++;
    if (EN.has(word)) en++;
  }

  const marks = (String(text ?? '').match(MARKS) || []).length;
  const esScore = es / w.length + (Math.min(marks, w.length) / w.length) * MARK_WEIGHT;
  const enScore = en / w.length;

  const total = esScore + enScore;
  // Shared jargon and proper nouns only: saying a language here would move a
  // speaker's whole conversation on the strength of nothing.
  if (total === 0) return { lang: null, confidence: 0 };

  return {
    lang: esScore > enScore ? 'es' : 'en',
    confidence: Number((Math.abs(esScore - enScore) / total).toFixed(2)),
  };
}
