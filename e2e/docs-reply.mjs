// Measures «Respuesta» with documents: a synthetic CV plus a long distractor
// document, five interview questions, and the prompt the local chat stand-in
// received for each. Node only; nothing leaves the machine.
//   node e2e/docs-reply.mjs            CV + 80 distractor notes (search)
//   node e2e/docs-reply.mjs --cv-only  the CV alone (sent whole)
//   node e2e/docs-reply.mjs --max      the limits: 10 documents of 200 000 characters,
//                                      the CV opening the first; fails if a warm search
//                                      (index cached) takes over 50 ms at the median
import { startMockGroq } from './mock-groq.mjs';
import { cvText } from './docs-fixtures.mjs';
import { splitPassages } from '../lib/passages.js';
import { askReply, documentsBlock, DOCUMENTS_MAX_CHARS } from '../lib/coach.js';

const TOPICS = [
  'gardening', 'tomatoes', 'sailing', 'marathon training', 'chess openings', 'pottery', 'astronomy',
  'bread baking', 'cycling routes', 'film photography', 'birdwatching', 'jazz records', 'hiking',
];
const filler = (i) => `Notes on ${TOPICS[i % TOPICS.length]} number ${i}: weekend plans, equipment lists, `
  + `seasonal reminders and a long paragraph about ${TOPICS[(i + 3) % TOPICS.length]} that has nothing to do with work. `.repeat(2);
const notes = Array.from({ length: 80 }, (_, i) => filler(i)).join('\n\n');

// Pseudo-words from a fixed seed: a vocabulary of a few thousand terms that shares no
// word with the questions, so the long documents cost what real prose costs to index.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const SYLLABLES = ['ka', 'lo', 'mi', 'ten', 'vor', 'sul', 'pra', 'dee', 'nu', 'gol', 'fia', 'zer', 'quo', 'bly', 'tash', 'rin'];
const VOCAB = Array.from({ length: 4000 }, () => Array.from({ length: 2 + Math.floor(rand() * 3) }, () => SYLLABLES[Math.floor(rand() * SYLLABLES.length)]).join(''));
const prose = (chars) => {
  const out = [];
  let n = 0;
  while (n < chars) {
    const sentence = `${Array.from({ length: 8 + Math.floor(rand() * 12) }, () => VOCAB[Math.floor(rand() * VOCAB.length)]).join(' ')}.`;
    out.push(sentence, rand() < 0.15 ? '\n\n' : ' ');
    n += sentence.length + 1;
  }
  return out.join('').slice(0, chars);
};
const MAX_CHARS = 200000;
const asDoc = (id, text) => ({ id, name: `${id}.txt`, enabled: true, passages: splitPassages(text).map((t, i) => ({ id: `${id}-${i}`, text: t })) });

const cvOnly = process.argv.includes('--cv-only');
const max = process.argv.includes('--max');
const documents = max
  ? Array.from({ length: 10 }, (_, i) => (i === 0
    ? asDoc('cv', `${cvText()}\n\n${prose(MAX_CHARS)}`.slice(0, MAX_CHARS))
    : asDoc(`doc${i}`, prose(MAX_CHARS))))
  : [
    { id: 'cv', name: 'cv.txt', enabled: true, passages: splitPassages(cvText()).map((text, i) => ({ id: `cv${i}`, text })) },
    ...(cvOnly ? [] : [{ id: 'notes', name: 'notes.txt', enabled: true, passages: splitPassages(notes).map((text, i) => ({ id: `n${i}`, text })) }]),
  ];

const QUESTIONS = [
  ['Tell me about the payment migration you led.', 'event-driven services, cutting checkout failures by 40%'],
  ['Which databases have you used?', 'PostgreSQL, MySQL, Redis'],
  ['What did you do at Rutas?', 'route optimisation API'],
  ['Did you ever manage people?', 'Mentored four engineers'],
  ['Where did you study?', 'Universidad Nacional de Colombia'],
];

const mock = await startMockGroq({ manifest: { cues: [] } });
const settings = { chatProvider: 'groq', keys: { groq: 'gsk_synthetic' }, groqBase: mock.url, lang: 'en' };
let hits = 0;
const turnsOf = (question) => [{ speaker: 'them', text: question }];
// Cold: the first call after the corpus changed builds the index. A fresh copy of the
// records with the same ids would hit the cache, so cold is forced with new ids.
const fresh = () => documents.map((d) => ({ ...d, id: `${d.id}-${Math.random()}` }));
const cold = [];
for (const [question] of QUESTIONS) {
  const docs = fresh();
  const s0 = performance.now();
  documentsBlock(docs, turnsOf(question));
  cold.push(performance.now() - s0);
}
documentsBlock(documents, turnsOf(QUESTIONS[0][0]));
const warm = [];
for (const [question, needle] of QUESTIONS) {
  const before = mock.chats.length;
  await askReply({ turns: turnsOf(question), settings, documents });
  const user = mock.chats[before]?.user || '';
  const hit = user.includes(needle);
  const sent = user.split("Learner's documents")[1]?.length ?? 0;
  hits += hit;
  console.log(`${hit ? 'HIT ' : 'MISS'} "${question}" -> prompt ${user.length} chars, documents block ~${sent}`);
  const s0 = performance.now();
  documentsBlock(documents, turnsOf(question));
  warm.push(performance.now() - s0);
}
await mock.close();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const top = (xs) => Math.max(...xs);
const passagesTotal = documents.reduce((n, d) => n + d.passages.length, 0);
const charsTotal = documents.reduce((n, d) => n + d.passages.reduce((m, p) => m + p.text.length, 0), 0);
const c0 = performance.now();
structuredClone(documents);
const cloneMs = performance.now() - c0;
const label = max ? `Limits (${documents.length} × ${MAX_CHARS} chars)` : cvOnly ? 'CV alone' : 'CV + notes';
console.log(`${label}: hit rate ${hits}/${QUESTIONS.length}; ${passagesTotal} passages, ${charsTotal} chars in passages (cap ${DOCUMENTS_MAX_CHARS} chars)`);
console.log(`  cold (index built): median ${median(cold).toFixed(1)} ms, max ${top(cold).toFixed(1)} ms`);
console.log(`  warm (index cached): median ${median(warm).toFixed(1)} ms, max ${top(warm).toFixed(1)} ms`);
console.log(`  structured clone of the records (what IndexedDB copies per read): ${cloneMs.toFixed(1)} ms`);
if (max) process.exit(median(warm) <= 50 ? 0 : 1);
process.exit(hits === QUESTIONS.length ? 0 : 1);
