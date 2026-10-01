// Who spoke, from speaker embeddings. The learner's print is enrolled once; the
// other voice has no print, so its centre is learnt from the turns assigned to it.

// Similarity to the learner's centre above which a turn is the learner's before
// any other voice is known (and, under 'hybrid', always). Under 'centres' this only
// decides turns before the other voice has a centre, so it has to survive every
// turn a meeting could open on, not just the two openings the fixtures use.
// Calibrated by e2e/speakers.mjs on 2026-10-01: every cue of the 14 clean fixtures
// tried as the opening (1 120 runs a threshold, pooled over 1/2/4 s and full),
// under 'centres'. The sweep peaks at 97 % at a single point, 0.51; 0.50 ties it.
// The previous round's 0.61 — the midpoint of a tie between two openings that
// both happen to be easy — scores 96 % on this harder measure.
export const MATCH_MIN = 0.5;
// Below `threshold − MARGIN`, a turn labelled 'them' is confident enough to shape
// the other voice's centre; in the grey zone above it, the turn is still labelled
// 'them' but left out of the centre — classify() records it with counts: false —
// until a correct() or assign() vouches for it. Only 'them' turns are gated: the
// learner's centre is already anchored by PRINT_WEIGHT, and a wrong 'me' is easy
// to correct, but a wrong 'them' can seed a centre nothing else corrects on its own.
// Calibrated the same way as MATCH_MIN, at that threshold, on 2026-10-01: clean
// accuracy peaks at a single point, 0.11. Room, every opening, 2 s crops: the gate
// takes the other centre from poisoned in 5 of 280 openings to 0, and the learner
// turns that reach it from 6 to 0, at the cost of more openings scoring under 90 %
// (9 → 20 of 280) and same-gender pooled accuracy easing from 98 % to 96 %.
export const MARGIN = 0.11;
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

export function createSpeakers(print, { threshold = MATCH_MIN, rule = 'centres', margin = MARGIN } = {}) {
  const p = normalize(print);
  const meSum = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) meSum[i] = p[i] * PRINT_WEIGHT;
  return { print: p, threshold, rule, margin, turns: new Map(), meSum, themSum: null, themCount: 0 };
}

function centreOf(state, who) {
  if (who === 'me') return normalize(state.meSum);
  return state.themCount > 0 ? normalize(state.themSum) : null;
}

// Running sums instead of rebuilding each centre from every counted turn on every
// call: both are the same vector, since the print and every stored turn are
// already unit length, so summing them once and normalizing is what meanOf() does
// turn by turn. Running sums are what let the every-opening calibration (20
// openings × 4 durations × dozens of threshold and margin candidates) finish in
// minutes instead of replaying each turn against an O(turns) scan.
function joinCentre(state, who, v) {
  if (who === 'me') { for (let i = 0; i < v.length; i++) state.meSum[i] += v[i]; return; }
  if (!state.themSum) state.themSum = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) state.themSum[i] += v[i];
  state.themCount++;
}

function leaveCentre(state, who, v) {
  if (who === 'me') { for (let i = 0; i < v.length; i++) state.meSum[i] -= v[i]; return; }
  for (let i = 0; i < v.length; i++) state.themSum[i] -= v[i];
  state.themCount--;
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
  // A 'them' call only joins the other voice's centre once it is clearly not the
  // learner; a grey-zone call is labelled but held back from shaping it (see MARGIN).
  const counts = result.speaker === 'me' || result.me < state.threshold - state.margin;
  state.turns.set(id, { vector: v, speaker: result.speaker, manual: false, counts });
  if (counts) joinCentre(state, result.speaker, v);
  return result;
}

export function assign(state, id, vector, speaker) {
  const v = normalize(vector);
  const existing = state.turns.get(id);
  if (existing?.counts) leaveCentre(state, existing.speaker, existing.vector);
  state.turns.set(id, { vector: v, speaker, manual: true, counts: true });
  joinCentre(state, speaker, v);
}

export function correct(state, id, speaker) {
  const t = state.turns.get(id);
  if (!t) return false;
  if (t.counts) leaveCentre(state, t.speaker, t.vector);
  t.speaker = speaker;
  t.manual = true;
  t.counts = true;
  joinCentre(state, speaker, t.vector);
  return true;
}

export function labelWindows(state, vectors) {
  return vectors.map((v) => decide(state, normalize(v)).speaker);
}
