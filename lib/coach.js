// Coaching layer: the suggested reply on demand and the closing report. The live
// chips and notes come from phrasebook.js and call no model at all. Every request goes
// through providers.js's callChat, so the coach runs on whichever AI the learner picked.

import { callChat, modelFor } from '../providers.js';

export const DEFAULT_COACH = {
  level: 'B1-B2',
  situation: 'conversación de trabajo en inglés',
  profile: '',
  sessionContext: '',
  lang: 'en',
};

// Profile cap. Enough for a summarised real background without eating Groq's free
// minute, and it stops a whole six-page CV pasted in from blowing through it.
export const PROFILE_MAX_CHARS = 1500;

function profileBlock(settings) {
  const texto = (settings.profile || '').trim().slice(0, PROFILE_MAX_CHARS);
  if (!texto) return '';
  return `\n\nAbout the learner (their real background — use ONLY these facts, never invent experience):\n${texto}`;
}

// Per-meeting notes ("entrevista técnica de Angular: signals, RxJS…"). Same
// token-budget rule as the profile.
export const CONTEXT_MAX_CHARS = 1500;

export function contextBlock(settings) {
  const texto = (settings.sessionContext || '').trim().slice(0, CONTEXT_MAX_CHARS);
  if (!texto) return '';
  return `\n\nToday's conversation context (topics and notes the learner wrote for this meeting — lean on them when answering knowledge questions):\n${texto}`;
}

class CoachError extends Error {}

// A thinking model spends its reasoning from the same ceiling before it writes any
// of the answer — the note on JSON_BUDGET records this for Groq's gpt-oss models,
// and Claude Opus 5 thinks by default, so every ceiling measured against a
// non-thinking model is too low for it. Groq keeps its measured figures: its free
// tier allows 8000 tokens a minute, so raising them there would trade a truncated
// answer for a rate-limit error. A ceiling is not a target — nothing is spent on
// headroom that goes unused.
const THINKING_FLOOR = { anthropic: 16000 };

// Only the gpt-oss models accept json_schema with constrained decoding on Groq, the
// one mode that cannot return invalid JSON; other Groq models reject json_schema, and
// a local server's support varies. Where the schema is withheld the prompt still asks
// for JSON and parseJsonLoose recovers it.
const GROQ_SCHEMA_MODELS = /^openai\/gpt-oss/;

function schemaFor(settings, schema) {
  if (!schema) return undefined;
  const id = settings.chatProvider || 'groq';
  if (id === 'local') return undefined;
  if (id === 'groq' && !GROQ_SCHEMA_MODELS.test(modelFor(settings, id, 'chat'))) return undefined;
  return schema;
}

async function ask({ settings, system, user, maxTokens = 700, schema = null, signal, chat = callChat }) {
  const ceiling = Math.max(maxTokens, THINKING_FLOOR[settings.chatProvider] || 0);
  return chat(settings, {
    system, user, maxTokens: ceiling, schema: schemaFor(settings, schema), signal, stage: '[coach]',
  });
}

// Extracts the first JSON object from a response, tolerating prose or ```json fences.
export function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// Groq's free tier allows 8000 tokens per minute across input and output. A report
// carrying the whole transcript eats that and returns 429, so the oldest turns are
// trimmed until it fits. Four characters per token is the usual rule of thumb.
// A Whisper repetition loop ("be able to" two hundred times) arrives as ONE segment,
// which MERGE_MAX_CHARS does not bound — that caps folding, not a single transcription.
// Left whole, one such turn is thousands of characters and dominates every prompt it
// reaches, so each turn contributes at most maxTurnChars.
const clip = (text, max) => {
  const t = String(text ?? '');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
};

// Consecutive turns by one speaker in one language read as a single turn: a
// monologue arrives as several sentence bubbles, and counting each against the
// limit would push the other speaker's last words out of the window. Each
// turn's text is clipped before it joins the run, never after: the cap bounds
// one transcription (a Whisper repetition loop lands as a single turn), not a
// run of sentence bubbles, and clipping the joined run would cut from its
// start and lose the monologue's newest sentences instead.
export function runsOf(turns, maxTurnChars = Infinity) {
  const runs = [];
  for (const t of turns) {
    const text = clip(String(t.text ?? ''), maxTurnChars);
    const last = runs[runs.length - 1];
    if (last && last.speaker === t.speaker && (last.lang || null) === (t.lang || null)) {
      last.text = `${last.text} ${text}`.trim();
    } else {
      runs.push({ speaker: t.speaker, lang: t.lang, text });
    }
  }
  return runs;
}

// A turn is labelled with its language when that language is not the session's own,
// or the session mixes both ('multi' has no single language to leave unlabelled).
// An entry with no lang (recorded before the field existed) gets no label either way.
export function turnsToText(turns, limit = 10, maxChars = Infinity, maxTurnChars = Infinity, sessionLang = 'en') {
  const lines = runsOf(turns, maxTurnChars)
    .slice(-limit)
    .map((t) => {
      const tag = t.lang && (t.lang !== sessionLang || sessionLang === 'multi') ? ` [${t.lang}]` : '';
      return `${t.speaker === 'me' ? 'LEARNER' : 'OTHER'}${tag}: ${t.text}`;
    });
  if (maxChars === Infinity) return lines.join('\n');

  const kept = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > maxChars && kept.length) break;
    kept.unshift(lines[i]);
  }
  return kept.join('\n');
}

// Leaves room for the system prompt and the 2800 output tokens within the free minute.
const REPORT_MAX_CHARS = 12000;

// A Whisper repetition loop is one segment of thousands of characters; MERGE_MAX_CHARS
// bounds folding, not a single transcription. Without a per-turn cap, turnsToText's
// "keep at least the last turn" rule passes the whole loop through.
const TURN_MAX_CHARS = 400;

// Every call that constrains the answer to a schema shares this budget. gpt-oss models
// spend reasoning tokens from max_completion_tokens BEFORE they write the JSON, so a
// tight cap truncates the object mid-key and Groq rejects the whole call with 400
// json_validate_failed. 1200 is the figure that stopped it for the reply in v1.17.1;
// the two live-suggestion calls that kept the old cap both hit the same 400 in
// production, and they went away with the live model layer rather than being retuned.
const JSON_BUDGET = 1200;

// Spanish-session override, appended to the reply prompt: same structure and
// fields, but the phrases to say are Spanish and a gloss is pointless for a
// native speaker — there the coach is professional support, not language help.
const SPANISH_MODE = `

IMPORTANT OVERRIDE: this conversation is in SPANISH, the learner's NATIVE language. They need
professional support (what to say, how to phrase it well in a work setting), not language help.
Every "en" field must contain the SPANISH phrase to say, in professional spoken register.
Return "es" as an empty string.`;

// Bilingual-session override, appended to the reply prompt: turns are now labelled
// (turnsToText), and the reply must speak whichever language the other person just
// used rather than defaulting to English.
const MULTI_MODE = `

This conversation mixes English and Spanish: turns are labelled with the language
they were spoken in ([en] or [es]), and your answer must be in the language of the
OTHER speaker's most recent turn.`;

const langMode = (settings) =>
  settings.lang === 'es' ? SPANISH_MODE : settings.lang === 'multi' ? MULTI_MODE : '';

// --- 1. Full reply on demand (keyboard shortcut) -----------------------------

const REPLY_SYSTEM = `You are helping a Spanish-speaking professional answer in a live English
conversation. They will read your answer OUT LOUD while the other person waits, so it must be
SPEAKABLE, not impressive.

"answer": EXACTLY ONE answer to the LAST question or point the other person raised — your single
best option, never alternatives. Spoken register, at the learner's level. Sentences of 12 words
or fewer; two short sentences beat one complex one. Everyday words the learner already knows; at
most ONE technical term per sentence, and only when the topic truly needs it — wrap that term in
**double asterisks** so the interface can highlight it. For a knowledge question (e.g. a
technical interview) the answer must be CORRECT: use the conversation-context notes if provided
plus your own knowledge, said simply. If the last turn was not a question, give the most natural
next thing to say.

"ideas": exactly 2 richer ways to express the same answer — fuller sentences with the precise
terminology, for the learner to STUDY after the conversation, not to read live.

Every item needs "en" (exactly what to say) and "es" (a short Spanish gloss, max 6 words).

If a background section is provided, ground personal answers in those real facts. Technical and
conceptual knowledge is fair game: teach them the right answer. What you must never invent is
their biography — employers, job titles, numbers or achievements not stated in the background:
the learner has to say this out loud as the truth. If the background does not cover a personal
question, stay honest and general rather than fabricating detail.`;

const REPLY_ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    properties: { en: { type: 'string' }, es: { type: 'string' } },
    required: ['en', 'es'],
    additionalProperties: false,
  },
};

const REPLY_SCHEMA = {
  type: 'object',
  properties: { answer: REPLY_ITEMS, ideas: REPLY_ITEMS },
  required: ['answer', 'ideas'],
  additionalProperties: false,
};

const cleanItems = (list) => (Array.isArray(list) ? list : [])
  .filter((i) => i && typeof i.en === 'string' && i.en.trim())
  .map((i) => ({ en: i.en.trim().replace(/^["“]|["”]$/g, ''), es: (i.es || '').trim() }))
  .slice(0, 4);

// Pure so Node can test it: the model's raw text in, the two groups out. One
// answer only — in a live conversation the learner reads the first option
// anyway, so alternatives are cost (screen, tokens, hesitation), not help.
export function parseReply(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new CoachError('[coach] Respuesta no válida del modelo.');
  const answer = cleanItems(parsed.answer).slice(0, 1);
  const ideas = cleanItems(parsed.ideas).slice(0, 2);
  if (!answer.length && !ideas.length) {
    throw new CoachError('[coach] El modelo no devolvió ninguna opción.');
  }
  return { answer, ideas };
}

export async function askReply({ turns, settings: given, signal, chat }) {
  const settings = { ...DEFAULT_COACH, ...given };
  const raw = await ask({
    settings,
    signal,
    chat,
    system: REPLY_SYSTEM + langMode(settings),
    user: `Learner level: ${settings.level}. Context: ${settings.situation}.`
      + `${profileBlock(settings)}${contextBlock(settings)}`
      // Capped by characters, not turns: soft cuts split one long question into
      // many small segments, so a turn count could drop the question itself. Below
      // TURN_MAX_CHARS a turn stays whole; past it, clip() truncates mid-content so a
      // single repetition loop can't dominate the budget.
      + `\n\nConversation so far:\n${turnsToText(turns, 10, 1200, TURN_MAX_CHARS, settings.lang)}`
      + `\n\nAnswer the other person's last turn for the learner: one speakable answer, then two study ideas.`,
    maxTokens: JSON_BUDGET,
    schema: REPLY_SCHEMA,
  });
  return parseReply(raw);
}

// --- 2. Closing report -------------------------------------------------------

const REPORT_SYSTEM = `Eres un profesor de inglés que analiza una conversación real de un hispanohablante.
"LEARNER" es tu alumno; "OTHER" es la otra persona. El «Resumen de la reunión» usa TODA la
conversación; el resto de secciones analiza SOLO las intervenciones del alumno.
La transcripción viene de reconocimiento automático: ignora errores obvios de puntuación o de
transcripción fonética y no los reportes como errores del alumno. Una frase con palabras
inexistentes o jerga técnica deformada («request quid», «ray-tree after heater») es casi siempre
el reconocedor destrozando un término técnico, no un error del alumno: trátala como ruido y no
la lleves a la tabla de gramática.

Responde en español, en Markdown, con exactamente estas secciones:

## Resumen de la reunión
De qué se habló, en 3 o 4 viñetas concretas con lo importante. Termina con una línea
**Pendientes:** y los compromisos o temas que quedaron abiertos (algo que revisar, enviar,
decidir o agendar), tomados solo de la transcripción. Si no quedó nada pendiente, dilo en una línea.

## Cómo lo hiciste
Dos o tres frases sobre cómo se desempeñó, concretas, sin adular.

## Errores de gramática
Tabla con columnas | Dijiste | Correcto | Por qué |. Máximo 8 filas, las más importantes.

## Traducciones literales del español
Lista de calcos detectados y cómo lo diría un nativo. Si no hay, dilo en una línea.

## Conectores y frases para aprender
Los conectores que le faltaron para hilar sus respuestas y 4 o 5 frases hechas que le conviene
memorizar para esta situación. Cada una con el inglés en negrita, una glosa corta en español y
el momento real de la conversación donde encajaba.

## Vocabulario para subir de nivel
5 expresiones que encajaban en esta conversación y no usó, cada una con un ejemplo tomado del contexto real.

## Fluidez
Muletillas, repeticiones, frases inacabadas. Menciónalo solo si hay evidencia en la transcripción.

## Nivel y plan
Nivel CEFR aproximado con una frase de justificación, tres ejercicios concretos para esta semana
y un consejo profesional de coach: qué hacer distinto en la próxima conversación para que cada
una mejore la anterior.`;

// Bilingual-session override: turns are now labelled by turnsToText, and only the
// English ones are the learner practising — the Spanish ones are their own language.
const REPORT_MULTI_MODE = `

Esta conversación mezcla inglés y español: las intervenciones llevan una etiqueta de
idioma ([en] o [es]). Las marcadas [es] son la lengua materna del alumno — úsalas solo
como contexto, nunca las evalúes; evalúa únicamente las marcadas [en].`;

// In a Spanish session the learner is a native speaker: grading their Spanish
// grammar or CEFR level would be noise. The report becomes a communication
// coach — clarity, fillers, better phrasings, professional formulas.
const REPORT_SYSTEM_ES = `Eres un coach de comunicación profesional que analiza una conversación
real EN ESPAÑOL de un profesional hispanohablante (por ejemplo, una entrevista técnica).
"LEARNER" es tu cliente; "OTHER" es la otra persona. El «Resumen de la reunión» usa TODA la
conversación; el resto de secciones analiza SOLO las intervenciones del cliente.
La transcripción viene de reconocimiento automático: palabras inexistentes o jerga deformada
son ruido del reconocedor, no errores del cliente — ignóralas.

Responde en español, en Markdown, con exactamente estas secciones:

## Resumen de la reunión
De qué se habló, en 3 o 4 viñetas concretas con lo importante. Termina con una línea
**Pendientes:** y los compromisos o temas que quedaron abiertos (algo que revisar, enviar,
decidir o agendar), tomados solo de la transcripción. Si no quedó nada pendiente, dilo en una línea.

## Cómo lo hiciste
Dos o tres frases sobre claridad, estructura y seguridad al responder, concretas, sin adular.

## Respuestas que se podían decir mejor
Tabla con columnas | Dijiste | Mejor | Por qué |. Máximo 6 filas: claridad, precisión técnica o
registro profesional — no corrijas gramática de nativo.

## Muletillas y fluidez
Muletillas, repeticiones, rodeos y frases inacabadas. Menciónalo solo si hay evidencia en la
transcripción.

## Fórmulas profesionales para aprender
4 o 5 fórmulas que encajaban en esta conversación (para estructurar una respuesta, ganar unos
segundos, cerrar un punto), cada una con el momento real donde encajaba.

## Plan
Tres ejercicios concretos para esta semana y un consejo profesional de coach: qué hacer distinto
en la próxima conversación para que cada una mejore la anterior.`;

export async function askReport({ turns, settings: given, signal, chat }) {
  const settings = { ...DEFAULT_COACH, ...given };
  const mine = turns.filter((t) => t.speaker === 'me').length;
  if (mine === 0) throw new CoachError('[coach] No hay intervenciones tuyas para analizar.');
  const texto = turnsToText(turns, 400, REPORT_MAX_CHARS, TURN_MAX_CHARS, settings.lang);
  // A turn can be clipped mid-content by TURN_MAX_CHARS without ever being dropped, so
  // a shrinking line count alone misses it — check the raw turns for one over the cap too.
  // Compared against runsOf's count, not turns.length: turnsToText emits one line per
  // run, and consecutive same-speaker turns collapsing into one run is routine, not a cut.
  const recortada = texto.split('\n').length < runsOf(turns).length
    || turns.some((t) => String(t.text ?? '').length > TURN_MAX_CHARS);
  return ask({
    settings,
    signal,
    chat,
    system: settings.lang === 'es' ? REPORT_SYSTEM_ES
      : REPORT_SYSTEM + (settings.lang === 'multi' ? REPORT_MULTI_MODE : ''),
    user: `Nivel declarado: ${settings.level}. Contexto: ${settings.situation}.`
      + `${profileBlock(settings)}${contextBlock(settings)}\n\n`
      + `Transcripción${recortada ? ' (sólo la parte final de la conversación)' : ' completa'}:\n${texto}`,
    maxTokens: 2800,
  });
}
