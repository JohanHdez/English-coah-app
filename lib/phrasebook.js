// The phrases a learner reaches for in a live conversation are a closed set: the
// same connectors, stalls and reactions work in every meeting. They are checked in
// rather than generated, so the live layer needs no API key, no network and no
// token budget — and cannot fail mid-conversation.

export const CATALOGUE = [
  { cat: 'Ganar tiempo', items: [
    { id: 'time.second',   en: 'Give me a second,',           es: 'dame un segundo' },
    { id: 'time.think',    en: 'Let me think about that,',    es: 'déjame pensarlo' },
    { id: 'time.good-q',   en: "That's a good question,",     es: 'buena pregunta' },
    { id: 'time.rephrase', en: 'Let me put it another way,',  es: 'déjame decirlo de otra forma' },
    { id: 'time.bear',     en: 'Bear with me a moment,',      es: 'dame un momento' },
  ] },
  { cat: 'Pedir aclaración', items: [
    { id: 'clarify.repeat',   en: 'Sorry, could you repeat that?', es: '¿puedes repetirlo?' },
    { id: 'clarify.clarify',  en: 'Could you clarify that?',       es: '¿puedes aclararlo?' },
    { id: 'clarify.mean',     en: 'What do you mean by that?',     es: '¿a qué te refieres?' },
    { id: 'clarify.follow',   en: 'Just to make sure I follow,',   es: 'para asegurarme de que te sigo' },
    { id: 'clarify.specific', en: 'Could you be more specific?',   es: '¿puedes concretar?' },
  ] },
  { cat: 'Contrastar', items: [
    { id: 'contrast.other-hand',  en: 'On the other hand,',    es: 'por otro lado' },
    { id: 'contrast.that-said',   en: 'That said,',            es: 'dicho eso' },
    { id: 'contrast.however',     en: 'However,',              es: 'sin embargo' },
    { id: 'contrast.in-practice', en: 'Although in practice,', es: 'aunque en la práctica' },
    { id: 'contrast.depends',     en: 'It depends on the case,', es: 'depende del caso' },
  ] },
  { cat: 'Añadir', items: [
    { id: 'add.in-addition', en: 'In addition,',                es: 'además' },
    { id: 'add.on-top',      en: 'On top of that,',             es: 'encima de eso' },
    { id: 'add.worth',       en: "It's also worth mentioning,", es: 'también vale la pena mencionar' },
    { id: 'add.more',        en: "What's more,",                es: 'es más' },
  ] },
  { cat: 'Estructurar', items: [
    { id: 'structure.two-things', en: 'There are two things here,', es: 'aquí hay dos cosas' },
    { id: 'structure.first',      en: 'First of all,',              es: 'en primer lugar' },
    { id: 'structure.then',       en: 'And then,',                  es: 'y luego' },
    { id: 'structure.break-down', en: 'Let me break that down,',    es: 'déjame desglosarlo' },
    { id: 'structure.example',    en: 'For example,',               es: 'por ejemplo' },
    { id: 'structure.my-case',    en: 'In my case,',                es: 'en mi caso' },
  ] },
  { cat: 'Cerrar', items: [
    { id: 'close.sum-up',   en: 'To sum up,',                     es: 'en resumen' },
    { id: 'close.in-short', en: 'So, in short,',                  es: 'en pocas palabras' },
    { id: 'close.thats-it', en: "That's basically it.",           es: 'eso es básicamente todo' },
    { id: 'close.answer',   en: 'Does that answer your question?', es: '¿responde eso a tu pregunta?' },
  ] },
  { cat: 'Reaccionar', items: [
    { id: 'react.makes-sense', en: 'That makes sense.',        es: 'tiene sentido' },
    { id: 'react.fair',        en: 'Fair enough.',             es: 'me parece justo' },
    { id: 'react.good-point',  en: 'Good point.',              es: 'buen punto' },
    { id: 'react.exactly',     en: 'Exactly.',                 es: 'exacto' },
    { id: 'react.agree',       en: "I'd agree with that.",     es: 'estaría de acuerdo' },
    { id: 'react.unsure',      en: "I'm not sure about that.", es: 'no estoy seguro de eso' },
  ] },
  // Saying "I don't know" well is worth more in an interview than any connector:
  // the 2026-08-30 report graded the learner partly on hesitation they had no
  // phrase to replace.
  { cat: 'Ser honesto', items: [
    { id: 'honest.not-directly', en: "I haven't worked with that directly,",  es: 'no he trabajado con eso directamente' },
    { id: 'honest.similar',      en: "but I've done something similar with,", es: 'pero he hecho algo parecido con' },
    { id: 'honest.approach',     en: "The way I'd approach it is,",           es: 'la forma en que lo enfocaría es' },
  ] },
];

// Seeded so the feature is visible the first time it runs: a learner who never
// opens the new settings section still gets the two categories that rescue a live
// conversation. An explicitly empty selection stays empty.
export const DEFAULT_PHRASE_IDS = [
  'time.second', 'time.think', 'time.good-q', 'time.rephrase', 'time.bear',
  'clarify.repeat', 'clarify.clarify', 'clarify.mean', 'clarify.follow', 'clarify.specific',
];

export const NOTE_TITLE_MAX = 60;
export const NOTE_BODY_MAX = 2000;
export const MAX_NOTES = 20;
export const MAX_CUSTOM = 40;

// The category travels with the phrase. The views group by it, and flattening it
// away here would mean every view rebuilding the grouping from CATALOGUE.
const FLAT = CATALOGUE.flatMap((c) => c.items.map((item) => ({ ...item, cat: c.cat })));

export const CUSTOM_CAT = 'Mis frases';
const clamp = (value, max) => String(value ?? '').trim().slice(0, max);

export function resolvePhrases(settings = {}) {
  const chosen = Array.isArray(settings.phraseIds) ? settings.phraseIds : DEFAULT_PHRASE_IDS;
  const wanted = new Set(chosen);
  // Catalogue order, not selection order: the learner ticks boxes down a list and
  // expects to read them back in the order they saw them.
  const builtins = FLAT.filter((item) => wanted.has(item.id));
  const custom = (Array.isArray(settings.customPhrases) ? settings.customPhrases : [])
    .filter((p) => p && String(p.en ?? '').trim())
    .slice(0, MAX_CUSTOM)
    .map((p) => ({ id: p.id, en: String(p.en).trim(), es: String(p.es ?? '').trim(), cat: CUSTOM_CAT }));
  return [...builtins, ...custom];
}

// The distinct categories, in the order the phrases already come in, so the
// filter row never lists one twice and never invents an order of its own.
export function phraseCategories(phrases = []) {
  return [...new Set((phrases || []).map((p) => p.cat || CUSTOM_CAT))];
}

export function resolveNotes(settings = {}) {
  const notes = Array.isArray(settings.notes) ? settings.notes : [];
  return notes
    .filter((n) => n && (String(n.title ?? '').trim() || String(n.body ?? '').trim()))
    .slice(0, MAX_NOTES)
    .map((n) => ({
      id: n.id,
      title: clamp(n.title, NOTE_TITLE_MAX),
      body: clamp(n.body, NOTE_BODY_MAX),
      open: n.open === true,
    }));
}

// One definition of "coaching is off", so the service worker's broadcast and a
// view's own first paint cannot disagree about what the learner should see.
export function resolveChips(settings = {}) {
  if (settings.liveCoach === false) return { phrases: [], notes: [] };
  return { phrases: resolvePhrases(settings), notes: resolveNotes(settings) };
}

// Flipping a note open is a settings write, and it happens from two contexts that
// share no code: the side panel (chrome.storage) and the overlay via the service
// worker (TOGGLE_NOTE). Keeping the read-modify-write here means one definition
// and one set of tests instead of two copies drifting apart.
export function toggleNoteOpen(settings = {}, id) {
  const notes = Array.isArray(settings.notes) ? settings.notes : [];
  // One note at a time. Two long notes open at once is what used to push the
  // conversation off the panel, and the coach's cap should never have to absorb it.
  const open = !(notes.find((n) => n && n.id === id) || {}).open;
  return { ...settings, notes: notes.map((n) => (n ? { ...n, open: n.id === id && open } : n)) };
}

// Adding a note mid-conversation is a settings write like toggling one, from the
// same two contexts, so it lives here for the same reason. The new note opens and
// the others close: a note written while someone waits is wanted on screen now,
// and one open note at a time is the rule toggleNoteOpen already keeps.
export function addNote(settings = {}, { title, body } = {}) {
  const notes = Array.isArray(settings.notes) ? settings.notes : [];
  const t = clamp(title, NOTE_TITLE_MAX);
  const b = clamp(body, NOTE_BODY_MAX);
  if (!t && !b) return settings;
  if (notes.length >= MAX_NOTES) return settings;
  const note = { id: 'n.' + Date.now(), title: t, body: b, open: true };
  return { ...settings, notes: [...notes.map((n) => (n ? { ...n, open: false } : n)), note] };
}

// Matching the language subtag, not a prefix: "eng-X" is not English here, and
// some platforms report the tag with an underscore.
const EN = /^en(?:[-_]|$)/i;
const US = /^en[-_]us$/i;

// The Web Speech API hands over whatever the OS installed, and choosing badly is
// worse than staying silent — an English phrase read by a Spanish voice teaches the
// wrong pronunciation. Chrome also offers network-backed voices, which would send
// the phrase to a server and quietly break the property that the chips need no
// connection, so a local voice wins even over a better-sounding remote one.
export function pickEnglishVoice(voices = []) {
  const english = (Array.isArray(voices) ? voices : [])
    .filter((v) => v && typeof v.lang === 'string' && EN.test(v.lang));
  if (!english.length) return null;
  const rank = (v) => (v.localService === false ? 2 : 0) + (US.test(v.lang) ? 0 : 1);
  return english.reduce((best, v) => (rank(v) < rank(best) ? v : best));
}
