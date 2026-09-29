// Synthesises the meetings Task 4's speaker-accuracy harness measures: one phone
// microphone hearing the learner next to it and the other speaker across the
// table through a laptop speaker. Sentences are read by macOS voices (`say`),
// converted with `afconvert`, laid on a timeline with a known ground truth, and
// optionally passed through the room simulation in `room.mjs`. Nothing here is
// recorded speech: no voice ever leaves this machine and the files are
// regenerated on demand.
//
// Usage: node e2e/fixtures.mjs
//   → writes e2e/fixtures/<learner>-<other>-<condition>.wav + .json
//     and e2e/fixtures/enroll-<learner>-<condition>.wav for every pairing.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENROLL_TEXT } from '../enroll-text.js';
import { laptopSpeaker, nearVoice } from './room.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');
const CACHE = join(FIXTURES, 'cache');
const RATE = 16000;
const ENROLL_RATE = 175;

export const LEARNERS = ['Paulina', 'Mónica'];
// A pair never uses the same voice twice, so each learner meets the other 7:
// 4 same-gender English voices, 2 male, and the one other Spanish voice.
export const OTHERS = ['Samantha', 'Karen', 'Moira', 'Tessa', 'Daniel', 'Rishi', 'Paulina', 'Mónica'];

// Voice names carry an accent; file names stay ASCII.
const SLUG = { Paulina: 'paulina', 'Mónica': 'monica', Samantha: 'samantha', Karen: 'karen', Moira: 'moira', Tessa: 'tessa', Daniel: 'daniel', Rishi: 'rishi' };

const RATES = [160, 185, 205];
const GAPS = [0.2, 0.4, 0.6, 1.0];
const START_SILENCE = 1.0;
const END_SILENCE = 2.0;

// Ten lines a side, alternating them → me: three short lines and two Spanish
// lines on the learner's side are the cases most likely to confuse a voice
// print, the rest ordinary work-meeting sentences.
export const TURNS = [
  { speaker: 'them', lang: 'en', text: "Let's start by reviewing the numbers from last week's sprint." },
  { speaker: 'me', lang: 'en', text: 'I finished the report, but I still need to double check the numbers.' },
  { speaker: 'them', lang: 'en', text: 'I think we should prioritize the checkout bug before anything else.' },
  { speaker: 'me', lang: 'en', text: 'Yes.' },
  { speaker: 'them', lang: 'en', text: 'Can you share the deck with the rest of the team by Friday?' },
  { speaker: 'me', lang: 'en', text: 'We can move the deadline if the client agrees to it.' },
  { speaker: 'them', lang: 'en', text: 'Okay, sure.' },
  { speaker: 'me', lang: 'es', text: 'Perdón, ¿puedes repetir la última parte?' },
  { speaker: 'them', lang: 'en', text: 'We are still waiting on approval from the legal department.' },
  { speaker: 'me', lang: 'en', text: 'I think the design looks good, but the color needs to change.' },
  { speaker: 'them', lang: 'en', text: 'The client asked for an extra week to review the proposal.' },
  { speaker: 'me', lang: 'en', text: 'Okay, sure.' },
  { speaker: 'them', lang: 'en', text: 'Yes.' },
  { speaker: 'me', lang: 'en', text: 'Let me check my calendar and send you the available times.' },
  { speaker: 'them', lang: 'en', text: 'I noticed the deployment failed twice this morning.' },
  { speaker: 'me', lang: 'es', text: 'Sí, eso lo revisamos la semana pasada.' },
  { speaker: 'them', lang: 'en', text: 'Right, exactly.' },
  { speaker: 'me', lang: 'en', text: 'Right, exactly.' },
  { speaker: 'them', lang: 'en', text: "Let's schedule a follow-up call once the tests are done." },
  { speaker: 'me', lang: 'en', text: 'I will talk to the team and confirm by tomorrow morning.' },
];

function hashKey(...parts) {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function seedFor(...parts) {
  return createHash('sha1').update(parts.join('|')).digest().readUInt32LE(0);
}

function synth(voice, rate, text) {
  mkdirSync(CACHE, { recursive: true });
  const key = hashKey(voice, rate, text);
  const wav = join(CACHE, `${key}.wav`);
  if (!existsSync(wav)) {
    const aiff = join(CACHE, `${key}.aiff`);
    execFileSync('say', ['-v', voice, '-r', String(rate), '-o', aiff, text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', aiff, wav]);
  }
  return readPcm(wav);
}

// Minimal RIFF reader: mono 16-bit PCM only, which is what afconvert wrote above.
function readPcm(path) {
  const buf = readFileSync(path);
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path}: not a PCM WAV`);
  if (fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) {
    throw new Error(`${path}: expected mono 16-bit ${RATE} Hz, got ${JSON.stringify(fmt)}`);
  }
  return new Int16Array(data.buffer, data.byteOffset, data.length / 2);
}

function writeWav(path, samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length * 2, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]));
}

function toFloat(int16) {
  const out = new Float32Array(int16.length);
  for (let n = 0; n < int16.length; n++) out[n] = int16[n] / 32768;
  return out;
}

function toInt16(float) {
  const out = new Int16Array(float.length);
  for (let n = 0; n < float.length; n++) out[n] = Math.round(Math.max(-1, Math.min(1, float[n])) * 32767);
  return out;
}

const round = (s) => Math.round(s * 1000) / 1000;

function buildEnroll(learner, condition) {
  mkdirSync(FIXTURES, { recursive: true });
  const wav = join(FIXTURES, `enroll-${SLUG[learner]}-${condition}.wav`);
  if (!existsSync(wav)) {
    let pcm = synth(learner, ENROLL_RATE, ENROLL_TEXT);
    if (condition === 'room') pcm = toInt16(nearVoice(toFloat(pcm), seedFor(learner, condition, 'enroll')));
    writeWav(wav, pcm);
  }
  return wav;
}

export function build({ learner, other, condition }) {
  mkdirSync(FIXTURES, { recursive: true });
  const enrollWav = buildEnroll(learner, condition);

  const parts = [new Int16Array(Math.round(START_SILENCE * RATE))];
  const cues = [];
  let at = START_SILENCE;

  TURNS.forEach((turn, i) => {
    const voice = turn.speaker === 'me' ? learner : other;
    const rate = RATES[i % RATES.length];
    let pcm = synth(voice, rate, turn.text);
    if (condition === 'room') {
      const seed = seedFor(learner, other, condition, i);
      const wet = turn.speaker === 'me' ? nearVoice(toFloat(pcm), seed) : laptopSpeaker(toFloat(pcm), seed);
      pcm = toInt16(wet);
    }
    const dur = pcm.length / RATE;
    cues.push({ speaker: turn.speaker, voice, lang: turn.lang, text: turn.text, start: round(at), end: round(at + dur) });
    parts.push(pcm);
    at += dur;
    if (i < TURNS.length - 1) {
      const gap = GAPS[i % GAPS.length];
      parts.push(new Int16Array(Math.round(gap * RATE)));
      at += gap;
    }
  });

  parts.push(new Int16Array(Math.round(END_SILENCE * RATE)));
  at += END_SILENCE;

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }

  const wav = join(FIXTURES, `${SLUG[learner]}-${SLUG[other]}-${condition}.wav`);
  writeWav(wav, out);
  const manifest = { rate: RATE, duration: round(at), learner, other, condition, cues };
  writeFileSync(join(FIXTURES, `${SLUG[learner]}-${SLUG[other]}-${condition}.json`), JSON.stringify(manifest, null, 2) + '\n');

  return { wav, enrollWav, manifest };
}

export function buildAll() {
  const built = [];
  for (const learner of LEARNERS) {
    for (const other of OTHERS) {
      if (other === learner) continue;
      for (const condition of ['clean', 'room']) {
        built.push(build({ learner, other, condition }));
      }
    }
  }
  return built;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const { wav, manifest } of buildAll()) {
    console.log(`${wav}  ${manifest.duration}s  (${manifest.learner} × ${manifest.other}, ${manifest.condition})`);
  }
}
