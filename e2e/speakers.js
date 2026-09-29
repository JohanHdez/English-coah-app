// Driven by e2e/speakers.mjs over the DevTools protocol. Chrome only embeds: it
// returns every vector it computed, and the Node side replays speaker.js over
// them with whatever threshold, rule and margin it is measuring.

import { createEmbedder, windows } from '../embed.js';
import { createSpeakers, classify, meanOf, MATCH_MIN } from '../speaker.js';

const SR = 16000;
const RULES = ['threshold', 'centres', 'hybrid'];
const base = new URL('../vendor/', location.href).href;

const downloads = new Map();
const embedderReady = createEmbedder({
  base,
  onProgress: (p) => {
    if (p.file && p.total) downloads.set(p.file, p.total);
  },
});
embedderReady.then(
  () => { document.getElementById('status').textContent = 'ready'; },
  (err) => { document.getElementById('status').textContent = `error: ${err?.message || err}`; },
);

function parseWav(buf) {
  const view = new DataView(buf);
  let off = 12;
  let rate = 0;
  let bits = 0;
  let channels = 0;
  while (off + 8 <= view.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(buf, off, 4));
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(off + 10, true);
      rate = view.getUint32(off + 12, true);
      bits = view.getUint16(off + 22, true);
    } else if (id === 'data') {
      if (channels !== 1 || rate !== SR || bits !== 16) throw new Error(`expected mono 16-bit ${SR} Hz`);
      const pcm = new Int16Array(buf.slice(off + 8, off + 8 + size));
      return Float32Array.from(pcm, (x) => x / 32768);
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

async function loadWav(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return parseWav(await res.arrayBuffer());
}

const timings = [];
async function timedEmbed(embedder, samples) {
  const t0 = performance.now();
  const v = await embedder.embed(samples);
  timings.push({ secs: samples.length / SR, ms: performance.now() - t0 });
  return v;
}

const enrollments = new Map();
async function enrollment(embedder, name) {
  if (!enrollments.has(name)) {
    const audio = await loadWav(`fixtures/${name}.wav`);
    const vectors = [];
    for (const w of windows(audio)) vectors.push(await timedEmbed(embedder, w));
    enrollments.set(name, { seconds: audio.length / SR, vectors });
  }
  return enrollments.get(name);
}

window.measure = async (name, durations = [1, 2, 4, 'full']) => {
  const embedder = await embedderReady;
  timings.length = 0;
  const manifest = await (await fetch(`fixtures/${name}.json`)).json();
  const audio = await loadWav(`fixtures/${name}.wav`);
  const [learner, , condition] = name.split('-');
  const enroll = await enrollment(embedder, `enroll-${learner}-${condition}`);
  const print = meanOf(enroll.vectors);

  const byCrop = new Map();
  const cues = [];
  for (const [index, cue] of manifest.cues.entries()) {
    const start = Math.round(cue.start * SR);
    const length = Math.round((cue.end - cue.start) * SR);
    const vectors = {};
    for (const d of durations) {
      const n = d === 'full' ? length : Math.min(length, Math.round(d * SR));
      const key = `${start}:${n}`;
      if (!byCrop.has(key)) byCrop.set(key, await timedEmbed(embedder, audio.subarray(start, start + n)));
      vectors[d] = byCrop.get(key);
    }
    cues.push({ index, truth: cue.speaker, lang: cue.lang, seconds: cue.end - cue.start, vectors });
  }

  const records = {};
  for (const d of durations) {
    records[d] = {};
    for (const rule of RULES) {
      const state = createSpeakers(print, { rule });
      records[d][rule] = cues.map((c) => {
        const r = classify(state, c.index, c.vectors[d]);
        return { index: c.index, truth: c.truth, speaker: r.speaker, me: r.me, them: r.them };
      });
    }
  }

  const downloadBytes = downloads.size ? [...downloads.values()].reduce((a, b) => a + b, 0) : null;
  return {
    name,
    learner: manifest.learner,
    other: manifest.other,
    condition,
    threshold: MATCH_MIN,
    enrollSeconds: enroll.seconds,
    print: [...print],
    enrollVectors: enroll.vectors.map((v) => [...v]),
    cues: cues.map((c) => ({ ...c, vectors: Object.fromEntries(Object.entries(c.vectors).map(([k, v]) => [k, [...v]])) })),
    records,
    embedMs: timings.slice(),
    downloadBytes,
  };
};

// The worker wraps the same embedder; this checks the message contract end to end
// and that it returns the vector the page computes for the same audio.
window.workerCheck = async (name) => {
  const embedder = await embedderReady;
  const audio = (await loadWav(`fixtures/${name}.wav`)).subarray(SR, 3 * SR);
  const direct = await embedder.embed(audio.slice());
  const worker = new Worker(new URL('../embed-worker.js', import.meta.url), { type: 'module' });
  const reply = (type) => new Promise((resolve, reject) => {
    const on = ({ data }) => {
      if (data.type === 'error') { worker.removeEventListener('message', on); reject(new Error(data.message)); }
      else if (data.type === type) { worker.removeEventListener('message', on); resolve(data); }
    };
    worker.addEventListener('message', on);
  });
  const progress = [];
  worker.addEventListener('message', ({ data }) => { if (data.type === 'progress') progress.push(data.status); });
  worker.postMessage({ type: 'init', base });
  await reply('ready');
  const samples = audio.slice();
  worker.postMessage({ type: 'embed', id: 7, samples }, [samples.buffer]);
  const { id, vector } = await reply('vector');
  worker.terminate();
  let maxDiff = 0;
  for (let i = 0; i < direct.length; i++) maxDiff = Math.max(maxDiff, Math.abs(direct[i] - vector[i]));
  return { id, dims: vector.length, maxDiff, progressEvents: progress.length };
};
