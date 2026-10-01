// How often the voice print gives each turn to the right speaker, when one
// microphone hears the learner and another voice through a laptop speaker.
//
// Chrome (headless, WASM) computes the embeddings of every cue cropped to 1, 2, 4 s
// and in full, plus the enrollment print; Node then replays speaker.js over those
// vectors, so every threshold and rule is decided exactly and cheaply.
//
// Usage: node e2e/speakers.mjs                  → embed in Chrome, then replay
//        node e2e/speakers.mjs --replay=<file>  → replay a saved vectors file only

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chrome } from './cdp.mjs';
import { build, LEARNERS, OTHERS, FIXTURES } from './fixtures.mjs';
import { serve } from '../tools/serve.mjs';
import { normalize, cosine, meanOf, createSpeakers, classify } from '../speaker.js';
import { Segmenter, SR } from '../lib/segmenter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RESULTS = join(HERE, 'results');
const PROFILE = join(HERE, '.profile');
const DURATIONS = [1, 2, 4, 'full'];
const RULES = ['threshold', 'centres', 'hybrid'];
const CONDITIONS = ['clean', 'room'];
const SPANISH = new Set(['Paulina', 'Mónica']);
const MALE = new Set(['Daniel', 'Rishi']);
const MIXED_MIN_S = 0.3;
const BLOCK = 1600;

const SLUG = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const today = new Date().toISOString().slice(0, 10);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

function pairs() {
  const out = [];
  for (const learner of LEARNERS) {
    for (const other of OTHERS) {
      if (other === learner) continue;
      for (const condition of CONDITIONS) out.push({ learner, other, condition, name: `${SLUG(learner)}-${SLUG(other)}-${condition}` });
    }
  }
  return out;
}

function group(other) {
  if (SPANISH.has(other)) return 'es-es';
  return MALE.has(other) ? 'cross' : 'same';
}

async function embedAll(list) {
  for (const p of list) {
    if (!existsSync(join(FIXTURES, `${p.name}.wav`)) || !existsSync(join(FIXTURES, `enroll-${SLUG(p.learner)}-${p.condition}.wav`))) {
      console.log(`building ${p.name}`);
      build(p);
    }
  }
  const server = await serve({ root: ROOT, port: 0 });
  const url = `http://127.0.0.1:${server.address().port}/e2e/speakers.html`;
  const chrome = await Chrome.launch({ profile: PROFILE, headless: true });
  try {
    const { targetId } = await chrome.send('Target.createTarget', { url });
    const session = await chrome.attach(targetId);
    await chrome.send('Runtime.enable', {}, session);
    chrome.on((method, params, sid) => {
      if (sid === session && method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        console.error('[page]', params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
    const t0 = Date.now();
    let status = 'loading';
    while (status === 'loading' || status === '') {
      if (Date.now() - t0 > 600000) throw new Error('[speakers] model did not load in 10 min');
      await new Promise((r) => setTimeout(r, 500));
      status = await chrome.evaluate(session, "document.getElementById('status')?.textContent || ''").catch(() => '');
    }
    if (status !== 'ready') throw new Error(`[speakers] ${status}`);
    console.log(`model ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const worker = await chrome.evaluate(session, `window.workerCheck(${JSON.stringify(list[0].name)})`);
    console.log(`embed-worker.js: id ${worker.id}, ${worker.dims} dims, max |Δ| vs page ${worker.maxDiff.toExponential(2)}, ${worker.progressEvents} progress events`);
    const runs = [];
    for (const p of list) {
      const s = Date.now();
      const r = await chrome.evaluate(session, `window.measure(${JSON.stringify(p.name)}, ${JSON.stringify(DURATIONS)})`);
      console.log(`${p.name}: ${r.cues.length} cues, ${r.embedMs.length} embeddings, ${((Date.now() - s) / 1000).toFixed(1)} s`);
      runs.push(r);
    }
    return { runs, worker };
  } finally {
    await chrome.close();
    server.close();
  }
}

// ---- replay ---------------------------------------------------------------

function calibrate(runs) {
  const points = [];
  for (const r of runs.filter((x) => x.condition === 'clean')) {
    const print = normalize(r.print);
    for (const c of r.cues) points.push({ me: cosine(normalize(c.vectors.full), print), isMe: c.truth === 'me' });
  }
  const values = [...new Set(points.map((p) => p.me))].sort((a, b) => a - b);
  const candidates = [values[0] - 1e-6, ...values.map((v, i) => (i + 1 < values.length ? (v + values[i + 1]) / 2 : v + 1e-6))];
  const accuracy = (t) => points.filter((p) => (p.me >= t) === p.isMe).length / points.length;
  let best = -1;
  let bestAt = [];
  for (const t of candidates) {
    const a = accuracy(t);
    if (a > best + 1e-12) { best = a; bestAt = [t]; } else if (Math.abs(a - best) < 1e-12) bestAt.push(t);
  }
  // Of an equally good range, its middle: the widest distance from both clouds.
  const raw = (bestAt[0] + bestAt.at(-1)) / 2;
  const threshold = Math.round(raw * 100) / 100;
  const learner = points.filter((p) => p.isMe).map((p) => p.me);
  const other = points.filter((p) => !p.isMe).map((p) => p.me);
  return { threshold, raw, accuracy: best, roundedAccuracy: accuracy(threshold), learner: stats(learner), other: stats(other), n: points.length };
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], p10: q(0.1), p50: q(0.5), p90: q(0.9), max: s.at(-1) };
}

function themCentre(state) {
  const vs = [];
  for (const t of state.turns.values()) if (t.speaker === 'them') vs.push(t.vector);
  return vs.length ? meanOf(vs) : null;
}

// Poisoned: at the end of the conversation the learnt other centre sits nearer
// the learner's print than the mean of the other voice's true turns does.
function replay(run, d, rule, threshold) {
  const print = normalize(run.print);
  const state = createSpeakers(print, { rule, threshold });
  const decisions = run.cues.map((c) => ({ ...classify(state, c.index, c.vectors[d]), truth: c.truth, seconds: c.seconds }));
  const centre = themCentre(state);
  const trueOther = meanOf(run.cues.filter((c) => c.truth === 'them').map((c) => c.vectors[d]));
  let poisoned = false;
  if (centre) poisoned = cosine(centre, print) > cosine(centre, trueOther);
  let absorbed = 0;
  let swallowed = 0;
  for (const c of run.cues) {
    const t = state.turns.get(c.index);
    if (c.truth === 'me' && t.speaker === 'them') absorbed++;
    if (c.truth === 'them' && t.speaker === 'me') swallowed++;
  }
  return { decisions, poisoned, absorbed, orphan: !centre, swallowed };
}

const acc = (decisions, filter = () => true) => {
  const ds = decisions.filter(filter);
  return ds.length ? ds.filter((x) => x.speaker === x.truth).length / ds.length : NaN;
};

function evaluateAll(runs, threshold, rules = RULES) {
  const out = [];
  for (const r of runs) {
    const t = typeof threshold === 'function' ? threshold(r) : threshold;
    for (const d of DURATIONS) {
      for (const rule of rules) {
        const { decisions, poisoned, absorbed, orphan, swallowed } = replay(r, d, rule, t);
        out.push({
          name: r.name, learner: r.learner, other: r.other, condition: r.condition, group: group(r.other), d, rule,
          accuracy: acc(decisions), long: acc(decisions, (x) => x.seconds >= 2),
          correct: decisions.filter((x) => x.speaker === x.truth).length, n: decisions.length,
          longCorrect: decisions.filter((x) => x.seconds >= 2 && x.speaker === x.truth).length,
          longN: decisions.filter((x) => x.seconds >= 2).length,
          poisoned, absorbed, orphan, swallowed,
        });
      }
    }
  }
  return out;
}

function pooled(rows, key = 'accuracy') {
  const [c, n] = key === 'long' ? ['longCorrect', 'longN'] : ['correct', 'n'];
  const total = rows.reduce((s, r) => s + r[n], 0);
  return total ? rows.reduce((s, r) => s + r[c], 0) / total : NaN;
}

// ---- mixed segments -------------------------------------------------------

function readWav(path) {
  const buf = readFileSync(path);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size));
      return Float32Array.from(pcm, (x) => x / 32768);
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

function mixedSegments(name) {
  const audio = readWav(join(FIXTURES, `${name}.wav`));
  const { cues } = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  const segments = [];
  let t = 0;
  const seg = new Segmenter('mic', (s) => segments.push(s), () => t);
  for (let i = 0; i + BLOCK <= audio.length; i += BLOCK) {
    const samples = audio.slice(i, i + BLOCK);
    let e = 0;
    for (const x of samples) e += x * x;
    t = (i + BLOCK) / SR * 1000;
    seg.push({ samples, rms: Math.sqrt(e / BLOCK) });
  }
  seg.flush();
  let mixed = 0;
  for (const s of segments) {
    const a = s.startedAt / 1000;
    const b = a + s.durationMs / 1000;
    const by = { me: 0, them: 0 };
    for (const c of cues) by[c.speaker] += Math.max(0, Math.min(b, c.end) - Math.max(a, c.start));
    if (by.me >= MIXED_MIN_S && by.them >= MIXED_MIN_S) mixed++;
  }
  return { segments: segments.length, mixed };
}

// ---- printing -------------------------------------------------------------

const pct = (x) => (Number.isNaN(x) ? '   – ' : `${(x * 100).toFixed(0).padStart(4)}%`);
const pad = (s, n) => String(s).padEnd(n);
const R3 = { threshold: 'thr', centres: 'cen', hybrid: 'hyb' };

function printFixtureTable(rows) {
  const head = DURATIONS.map((d) => RULES.map((r) => `${pad(d === 'full' ? 'full' : `${d}s`, 4)}${R3[r]}`.padStart(8)).join('')).join(' |');
  console.log(`${pad('learner × other', 22)}${pad('cond', 6)}${head}`);
  for (const r of pairs()) {
    if (!rows.some((y) => y.name === r.name)) continue;
    const cells = DURATIONS.map((d) => RULES.map((rule) => {
      const x = rows.find((y) => y.name === r.name && y.d === d && y.rule === rule);
      return pct(x.accuracy).padStart(8);
    }).join('')).join(' |');
    console.log(`${pad(`${r.learner} × ${r.other}`, 22)}${pad(r.condition, 6)}${cells}`);
  }
}

function printSummary(rows, key, title) {
  console.log(`\n${title}`);
  const groups = ['same', 'cross', 'es-es'];
  console.log(`${pad('cond', 6)}${pad('dur', 5)}${groups.map((g) => RULES.map((r) => `${g} ${R3[r]}`.padStart(11)).join('')).join(' |')}`);
  for (const c of CONDITIONS) {
    for (const d of DURATIONS) {
      const cells = groups.map((g) => RULES.map((rule) => pct(pooled(rows.filter((x) => x.condition === c && x.d === d && x.rule === rule && x.group === g), key)).padStart(11)).join('')).join(' |');
      console.log(`${pad(c, 6)}${pad(d === 'full' ? 'full' : `${d}s`, 5)}${cells}`);
    }
  }
}

function printPoisoning(rows) {
  console.log(`\nCentre poisoning, per rule, of 14 fixtures and 140 turns a side per condition:`);
  console.log('  P = fixtures whose final other centre is nearer the print than the mean of the true other turns');
  console.log('  A = learner turns absorbed into the other centre;  O = fixtures where no other centre ever formed;');
  console.log('  S = other-voice turns swallowed into the learner centre');
  console.log(`${pad('cond', 6)}${pad('dur', 5)}${RULES.map((r) => pad(`${r} P/A/O/S`, 22)).join('')}`);
  for (const c of CONDITIONS) {
    for (const d of DURATIONS) {
      const cells = RULES.map((rule) => {
        const xs = rows.filter((x) => x.condition === c && x.d === d && x.rule === rule);
        const sum = (k) => xs.reduce((s, x) => s + x[k], 0);
        return pad(`${xs.filter((x) => x.poisoned).length} / ${sum('absorbed')} / ${xs.filter((x) => x.orphan).length} / ${sum('swallowed')}`, 22);
      }).join('');
      console.log(`${pad(c, 6)}${pad(d === 'full' ? 'full' : `${d}s`, 5)}${cells}`);
    }
  }
}

// How the headline cell and the poisoning counts move with the threshold, so the
// calibrated value can be judged against its neighbours rather than taken alone.
function printSensitivity(runs, thresholds) {
  console.log('\nThreshold sensitivity: room, 2 s crops, same-gender pairs, all turns; P/A/O/S over all 14 room fixtures');
  console.log(`${pad('thr', 6)}${RULES.map((r) => pad(r, 26)).join('')}`);
  for (const t of thresholds) {
    const rows = evaluateAll(runs.filter((r) => r.condition === 'room'), t).filter((x) => x.d === 2);
    const cells = RULES.map((rule) => {
      const xs = rows.filter((x) => x.rule === rule);
      const sum = (k) => xs.reduce((s, x) => s + x[k], 0);
      const a = pct(pooled(xs.filter((x) => x.group === 'same')));
      return pad(`${a}  ${xs.filter((x) => x.poisoned).length}/${sum('absorbed')}/${xs.filter((x) => x.orphan).length}/${sum('swallowed')}`, 26);
    }).join('');
    console.log(`${pad(t.toFixed(2), 6)}${cells}`);
  }
}


// ---- rule-aware calibration -------------------------------------------------
// Under 'centres' the threshold only decides turns before the other voice has a
// centre, so it is chosen by the accuracy of 'centres' itself: clean fixtures,
// all four durations pooled. Of the best accuracy, the widest flat run of
// candidates wins and its middle is taken.

const CAL_RULE = 'centres';
const steps = (from, to, step) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => Math.round((from + i * step) * 100) / 100);

// A meeting can open with either speaker. Every fixture happens to open with the
// other voice, which hands 'centres' a free correct first centre; rotating to the
// first learner turn is the one case where the learner's own threshold is what
// decides. Calibrating on the mean of both orderings picks a value that holds up
// either way a real meeting starts, not just the one the fixtures happen to use.
function rotateToLearner(run) {
  const first = run.cues.findIndex((c) => c.truth === 'me');
  if (first <= 0) return run;
  return { ...run, cues: [...run.cues.slice(first), ...run.cues.slice(0, first)] };
}

function cleanAccuracy(runs, threshold) {
  const clean = runs.filter((r) => r.condition === 'clean');
  const original = pooled(evaluateAll(clean, threshold, [CAL_RULE]));
  const rotated = pooled(evaluateAll(clean.map(rotateToLearner), threshold, [CAL_RULE]));
  return (original + rotated) / 2;
}

function widestBest(values, scores) {
  const best = Math.max(...scores);
  let run = null;
  let widest = null;
  scores.forEach((a, i) => {
    if (Math.abs(a - best) < 1e-12) {
      run = run && run.end === i - 1 ? { start: run.start, end: i } : { start: i, end: i };
      if (!widest || run.end - run.start > widest.end - widest.start) widest = { ...run };
    } else run = null;
  });
  return { best, from: values[widest.start], to: values[widest.end], pick: values[Math.floor((widest.start + widest.end) / 2)] };
}

// Memoized by fixture name: print and enrollVectors never change across a sweep,
// only p and delta do, and the sweep calls this thousands of times.
const enrollSimCache = new Map();
function enrollSimilarities(run) {
  if (enrollSimCache.has(run.name)) return enrollSimCache.get(run.name);
  const print = normalize(run.print);
  const sims = run.enrollVectors.map((v) => cosine(normalize(v), print)).sort((a, b) => a - b);
  enrollSimCache.set(run.name, sims);
  return sims;
}

const percentileOf = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];

function calibrateGlobal(runs) {
  const ts = steps(0.3, 0.7, 0.01);
  const scores = ts.map((t) => cleanAccuracy(runs, t));
  console.log(`\nGlobal threshold under '${CAL_RULE}': clean accuracy, all durations pooled (0.30–0.70 by 0.01)`);
  for (let i = 0; i < ts.length; i += 8) console.log('  ' + ts.slice(i, i + 8).map((t, j) => `${t.toFixed(2)} ${pct(scores[i + j])}`).join('  '));
  const w = widestBest(ts, scores);
  console.log(`  best ${pct(w.best)} over ${w.from.toFixed(2)}–${w.to.toFixed(2)} → ${w.pick.toFixed(2)}`);
  return { threshold: w.pick, clean: w.best, from: w.from, to: w.to };
}

function calibratePerLearner(runs) {
  const ps = [0, 0.1, 0.25, 0.5];
  const deltas = steps(0, 0.6, 0.01);
  const seen = new Map();
  for (const r of runs) {
    const key = `${r.learner} ${r.condition}`;
    if (!seen.has(key)) seen.set(key, enrollSimilarities(r));
  }
  console.log(`\nPer-learner threshold = percentile_p(enrollment windows · print) − delta, under '${CAL_RULE}'`);
  for (const [k, sims] of seen) {
    console.log(`  ${pad(k, 14)} ${sims.length} windows: min ${sims[0].toFixed(3)}  p10 ${percentileOf(sims, 0.1).toFixed(3)}  p25 ${percentileOf(sims, 0.25).toFixed(3)}  p50 ${percentileOf(sims, 0.5).toFixed(3)}`);
  }
  console.log(`\n  Delta sweep 0.00–0.60 by 0.01, clean accuracy (mean of both orderings), per percentile:`);
  console.log(`  ${pad('p', 6)}${pad('best', 7)}${pad('flat band', 14)}${pad('pick', 6)}`);
  let chosen = null;
  for (const p of ps) {
    const scores = deltas.map((d) => cleanAccuracy(runs, (r) => percentileOf(enrollSimilarities(r), p) - d));
    const w = widestBest(deltas, scores);
    console.log(`  ${pad(p.toFixed(2), 6)}${pad(pct(w.best).trim(), 7)}${pad(`${w.from.toFixed(2)}–${w.to.toFixed(2)}`, 14)}${pad(w.pick.toFixed(2), 6)}`);
    const width = w.to - w.from;
    if (!chosen || w.best > chosen.clean + 1e-12 || (Math.abs(w.best - chosen.clean) < 1e-12 && width > chosen.to - chosen.from + 1e-9)) {
      chosen = { p, delta: w.pick, clean: w.best, from: w.from, to: w.to };
    }
  }
  console.log(`  chosen p=${chosen.p.toFixed(2)}, delta=${chosen.delta.toFixed(2)}; derived thresholds: ${[...seen].map(([k, sims]) => `${k} ${(percentileOf(sims, chosen.p) - chosen.delta).toFixed(3)}`).join(', ')}`);
  return { ...chosen, thresholdOf: (r) => percentileOf(enrollSimilarities(r), chosen.p) - chosen.delta };
}

// Every fixture opens with the other voice, which hands 'centres' a correct first
// centre whatever the threshold. Rotating each conversation to open on each of the
// learner's ten turns shows what the threshold costs when the learner speaks first.
function printOpenings(runs, thresholds) {
  console.log(`\nOpening sensitivity: room, '${CAL_RULE}', each conversation rotated to open on each learner turn (140 runs)`);
  console.log(`${pad('thr', 14)}${DURATIONS.map((d) => pad(d === 'full' ? 'full' : `${d}s`, 28)).join('')}`);
  for (const [label, threshold] of thresholds) {
    const cells = DURATIONS.map((d) => {
      let ok = 0;
      let n = 0;
      let worst = 1;
      let low = 0;
      for (const r of runs.filter((x) => x.condition === 'room')) {
        const t = typeof threshold === 'function' ? threshold(r) : threshold;
        for (let start = 1; start < r.cues.length; start += 2) {
          const cues = [...r.cues.slice(start), ...r.cues.slice(0, start)];
          const state = createSpeakers(normalize(r.print), { rule: CAL_RULE, threshold: t });
          let k = 0;
          for (const c of cues) if (classify(state, c.index, c.vectors[d]).speaker === c.truth) k++;
          ok += k;
          n += cues.length;
          worst = Math.min(worst, k / cues.length);
          if (k / cues.length < 0.9) low++;
        }
      }
      return pad(`${pct(ok / n).trim()} worst ${pct(worst).trim()} <90%: ${low}`, 28);
    }).join('');
    console.log(`${pad(label, 14)}${cells}`);
  }
}

function roomReport(runs, threshold, label) {
  const rows = evaluateAll(runs.filter((r) => r.condition === 'room'), threshold, [CAL_RULE]);
  console.log(`\n${label}: room, '${CAL_RULE}', all turns (worst pair; poisoning P/A/O/S as above)`);
  console.log(`${pad('dur', 6)}${pad('same', 7)}${pad('cross', 7)}${pad('es-es', 7)}${pad('worst pair', 30)}P/A/O/S`);
  const summary = {};
  for (const d of DURATIONS) {
    const xs = rows.filter((x) => x.d === d);
    const g = (k) => pooled(xs.filter((x) => x.group === k));
    const worst = [...xs].sort((a, b) => a.accuracy - b.accuracy)[0];
    const sum = (k) => xs.reduce((n, x) => n + x[k], 0);
    const pas = `${xs.filter((x) => x.poisoned).length}/${sum('absorbed')}/${xs.filter((x) => x.orphan).length}/${sum('swallowed')}`;
    summary[d] = { same: g('same'), cross: g('cross'), esEs: g('es-es'), worst: { name: `${worst.learner} × ${worst.other}`, accuracy: worst.accuracy }, pas };
    console.log(`${pad(d === 'full' ? 'full' : `${d}s`, 6)}${pct(g('same')).padEnd(7)}${pct(g('cross')).padEnd(7)}${pct(g('es-es')).padEnd(7)}${pad(`${worst.learner} × ${worst.other} ${pct(worst.accuracy).trim()}`, 30)}${pas}`);
  }
  return summary;
}

// Both orderings, for the report and for the adoption decision: the original fixtures
// (open with the other voice) and each rotated to start at the first learner turn.
function roomBothOrderings(runs, threshold, label) {
  const orig = roomReport(runs, threshold, `${label} — original order (other voice opens)`);
  const rot = roomReport(runs.map(rotateToLearner), threshold, `${label} — rotated (learner opens)`);
  return { orig, rot };
}

const sameAt2s = (summary) => (summary.orig[2].same + summary.rot[2].same) / 2;
const worstAt2s = (summary) => Math.min(summary.orig[2].worst.accuracy, summary.rot[2].worst.accuracy);

function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// ---- main -----------------------------------------------------------------

const replayFile = arg('replay');
let runs;
let worker = null;
if (replayFile) {
  ({ runs, worker } = JSON.parse(readFileSync(replayFile, 'utf8')));
} else {
  const started = Date.now();
  const only = arg('only');
  ({ runs, worker } = await embedAll(pairs().filter((p) => !only || p.name.includes(only))));
  console.log(`embedding took ${((Date.now() - started) / 60000).toFixed(1)} min`);
  mkdirSync(RESULTS, { recursive: true });
  const vectorsFile = join(RESULTS, `speakers-${today}-vectors.json`);
  writeFileSync(vectorsFile, JSON.stringify({ runs, worker }));
  console.log(`vectors: ${vectorsFile}`);
}

// The page decided with speaker.js's default threshold; the Node replay must
// reproduce it exactly, or the replayed numbers below would not describe the code.
let mismatches = 0;
for (const r of runs) {
  for (const d of DURATIONS) {
    for (const rule of RULES) {
      const { decisions } = replay(r, d, rule, r.threshold);
      r.records[d][rule].forEach((rec, i) => { if (rec.speaker !== decisions[i].speaker) mismatches++; });
    }
  }
}
console.log(`\nreplay vs page decisions (threshold ${runs[0].threshold}): ${mismatches} mismatches`);

const cal = calibrate(runs);
const f = (x) => x.toFixed(3);
console.log(`\nCalibration (clean, full turns, ${cal.n} turns): similarity to the print`);
console.log(`  learner turns  min ${f(cal.learner.min)}  p10 ${f(cal.learner.p10)}  p50 ${f(cal.learner.p50)}  p90 ${f(cal.learner.p90)}  max ${f(cal.learner.max)}`);
console.log(`  other turns    min ${f(cal.other.min)}  p10 ${f(cal.other.p10)}  p50 ${f(cal.other.p50)}  p90 ${f(cal.other.p90)}  max ${f(cal.other.max)}`);
console.log(`  threshold ${cal.threshold.toFixed(2)} (optimum ${f(cal.raw)}): clean accuracy ${pct(cal.accuracy)} at the optimum, ${pct(cal.roundedAccuracy)} at ${cal.threshold.toFixed(2)}`);

console.log(`  (print-only optimum; the rule-aware calibration below replaces it)`);

const global = calibrateGlobal(runs);
const globalRoom = roomBothOrderings(runs, global.threshold, `Global ${global.threshold.toFixed(2)}`);
const perLearner = calibratePerLearner(runs);
const perLearnerRoom = roomBothOrderings(runs, perLearner.thresholdOf, `Per learner p=${perLearner.p.toFixed(2)} delta=${perLearner.delta.toFixed(2)}`);

// Adopted: the better on room, same-gender, 2 s, averaged over both orderings;
// the worse-ordering worst pair at 2 s breaks a tie.
const better = (a, b) => sameAt2s(a) - sameAt2s(b) || worstAt2s(a) - worstAt2s(b);
const decision = better(perLearnerRoom, globalRoom);
const adoptPerLearner = decision > 0;
const adopted = adoptPerLearner ? perLearner.thresholdOf : global.threshold;
const adoptedLabel = adoptPerLearner ? `per learner (p=${perLearner.p.toFixed(2)}, delta=${perLearner.delta.toFixed(2)})` : `global ${global.threshold.toFixed(2)}`;
printOpenings(runs, [
  ...[0.39, 0.45, 0.5, 0.55, global.threshold, 0.6, 0.65, 0.7].filter((t, i, a) => a.indexOf(t) === i).sort((a, b) => a - b).map((t) => [t.toFixed(2), t]),
  [`p${perLearner.p}−${perLearner.delta.toFixed(2)}`, perLearner.thresholdOf],
]);
console.log(`\nRoom same-gender @2s, mean of both orderings: global ${pct(sameAt2s(globalRoom))} (worst-ordering worst pair ${pct(worstAt2s(globalRoom))}), per-learner ${pct(sameAt2s(perLearnerRoom))} (worst-ordering worst pair ${pct(worstAt2s(perLearnerRoom))})`);
console.log(`Adopted: ${adoptedLabel}${decision === 0 ? ' (tie on room same-gender 2 s and worst pair: the global value, which needs no new code)' : ''}`);

const rows = evaluateAll(runs, adopted);
console.log(`\n==== threshold: ${adoptedLabel} ====`);
console.log('\nAccuracy per fixture (all 20 turns, each cropped to the duration):');
printFixtureTable(rows);
printSummary(rows, 'accuracy', 'Summary, all turns (same = female English other voice, cross = male, es-es = the other Spanish voice):');
printSummary(rows, 'long', 'Summary, turns of 2 s or more only (scored; every turn still passes through the state):');
printPoisoning(rows);
printSensitivity(runs, [...new Set([0.3, 0.35, cal.threshold, global.threshold, 0.45, 0.5, 0.55, 0.6])].sort((a, b) => a - b));

console.log('\nMixed segments (lib/segmenter.js over the conversation WAV; both speakers ≥ 0.3 s in one segment):');
const mixed = {};
for (const c of CONDITIONS) {
  let segs = 0;
  let mix = 0;
  for (const p of pairs().filter((x) => x.condition === c && runs.some((r) => r.name === x.name))) {
    const m = mixedSegments(p.name);
    segs += m.segments;
    mix += m.mixed;
  }
  mixed[c] = { segments: segs, mixed: mix, share: mix / segs };
  console.log(`  ${pad(c, 6)} ${mix} of ${segs} segments (${(100 * mix / segs).toFixed(1)}%)`);
}

const allMs = runs.flatMap((r) => r.embedMs);
const twoS = allMs.filter((x) => Math.abs(x.secs - 2) < 1e-6).map((x) => x.ms);
const threeS = allMs.filter((x) => Math.abs(x.secs - 3) < 1e-6).map((x) => x.ms);
const ms = (xs) => `p50 ${percentile(xs, 0.5).toFixed(0)} ms, p90 ${percentile(xs, 0.9).toFixed(0)} ms (n=${xs.length})`;
console.log('\nEmbedding time (headless Chrome, WASM, one thread, q8):');
console.log(`  2 s crops        ${ms(twoS)}`);
console.log(`  3 s enroll wins  ${threeS.length ? ms(threeS) : 'cached'}`);
console.log(`  every embedding  ${ms(allMs.map((x) => x.ms))}`);
const download = runs.find((r) => r.downloadBytes)?.downloadBytes;
console.log(`  model files      ${download ? `${(download / 1e6).toFixed(1)} MB` : 'unknown'}`);

mkdirSync(RESULTS, { recursive: true });
const out = join(RESULTS, `speakers-${today}.json`);
writeFileSync(out, JSON.stringify({
  date: today, calibration: { printOnly: cal, global, globalRoom, perLearner: { p: perLearner.p, delta: perLearner.delta, clean: perLearner.clean }, perLearnerRoom, adopted: adoptedLabel }, mixed, worker,
  embedMs: { twoS: { p50: percentile(twoS, 0.5), p90: percentile(twoS, 0.9) }, all: { p50: percentile(allMs.map((x) => x.ms), 0.5), p90: percentile(allMs.map((x) => x.ms), 0.9) } },
  downloadBytes: download ?? null,
  rows,
}, null, 2));
console.log(`\nresults: ${out}`);
