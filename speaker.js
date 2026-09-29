// Who spoke, from speaker embeddings. The learner's print is enrolled once; the
// other voice has no print, so its centre is learnt from the turns assigned to it.

// Similarity to the learner's centre above which a turn is the learner's before
// any other voice is known (and, under 'hybrid', always). Calibrated by e2e/speakers.mjs
// on 2026-09-29: over 280 clean full turns, learner turns scored 0.394–0.937 against
// the print (p10 0.596) and other voices -0.053–0.558 (p90 0.373); 0.39 is the
// accuracy optimum there (96 %). Under 'centres', room, 2 s crops, same-gender pairs:
// 94 % (hybrid and threshold 84 %); one pairing never grows an other centre at 0.39.
export const MATCH_MIN = 0.39;
// The print outweighs any single turn, so one misassigned turn cannot drag the
// learner's centre toward the other voice.
export const PRINT_WEIGHT = 3;

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function meanOf(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) {
    const u = normalize(v);
    for (let i = 0; i < u.length; i++) out[i] += u[i];
  }
  return normalize(out);
}

export function createSpeakers(print, { threshold = MATCH_MIN, rule = 'centres' } = {}) {
  return { print: normalize(print), threshold, rule, turns: new Map() };
}

function centreOf(state, who) {
  const vectors = [];
  for (const t of state.turns.values()) if (t.speaker === who) vectors.push(t.vector);
  if (who === 'me') return meanOf([...Array(PRINT_WEIGHT).fill(state.print), ...vectors]);
  return vectors.length ? meanOf(vectors) : null;
}

function decide(state, v) {
  const me = cosine(v, centreOf(state, 'me'));
  const centre = centreOf(state, 'them');
  const them = centre ? cosine(v, centre) : null;
  let speaker;
  if (them === null || state.rule === 'threshold') speaker = me >= state.threshold ? 'me' : 'them';
  else if (state.rule === 'centres') speaker = me >= them ? 'me' : 'them';
  else speaker = me >= state.threshold || me >= them ? 'me' : 'them';
  return { speaker, me, them };
}

export function classify(state, id, vector) {
  const v = normalize(vector);
  const result = decide(state, v);
  state.turns.set(id, { vector: v, speaker: result.speaker, manual: false });
  return result;
}

export function assign(state, id, vector, speaker) {
  state.turns.set(id, { vector: normalize(vector), speaker, manual: true });
}

export function correct(state, id, speaker) {
  const t = state.turns.get(id);
  if (!t) return false;
  t.speaker = speaker;
  t.manual = true;
  return true;
}

export function labelWindows(state, vectors) {
  return vectors.map((v) => decide(state, normalize(v)).speaker);
}
