// Measures «Respuesta» with documents: a synthetic CV plus a long distractor
// document, five interview questions, and the prompt the local chat stand-in
// received for each. Node only; nothing leaves the machine.
//   node e2e/docs-reply.mjs            CV + 80 distractor notes (search)
//   node e2e/docs-reply.mjs --cv-only  the CV alone (sent whole)
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

const cvOnly = process.argv.includes('--cv-only');
const documents = [
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
const times = [];
for (const [question, needle] of QUESTIONS) {
  const before = mock.chats.length;
  await askReply({ turns: [{ speaker: 'them', text: question }], settings, documents });
  const user = mock.chats[before]?.user || '';
  const hit = user.includes(needle);
  const sent = user.split("Learner's documents")[1]?.length ?? 0;
  hits += hit;
  console.log(`${hit ? 'HIT ' : 'MISS'} "${question}" -> prompt ${user.length} chars, documents block ~${sent}`);
  const s0 = performance.now();
  documentsBlock(documents, [{ speaker: 'them', text: question }]);
  times.push(performance.now() - s0);
}
await mock.close();
const sorted = [...times].sort((a, b) => a - b);
const passagesTotal = documents.reduce((n, d) => n + d.passages.length, 0);
console.log(`${cvOnly ? 'CV alone' : 'CV + notes'}: hit rate ${hits}/${QUESTIONS.length}; search over ${passagesTotal} passages (cap ${DOCUMENTS_MAX_CHARS} chars): `
  + `median ${sorted[2].toFixed(1)} ms, max ${sorted[4].toFixed(1)} ms (index built per call, cold first call included)`);
process.exit(hits === QUESTIONS.length ? 0 : 1);
