import test from 'node:test';
import assert from 'node:assert/strict';
import { prng, biquad, reverb, gainDb, laptopSpeaker } from './room.mjs';

const tone = (f, secs = 1, sr = 16000) => Float32Array.from({ length: sr * secs }, (_, n) => Math.sin(2 * Math.PI * f * n / sr));
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

test('prng is deterministic', () => {
  const a = prng(7), b = prng(7);
  assert.equal(a(), b());
});

test('the high-pass removes a low tone and keeps a mid tone', () => {
  assert.ok(rms(biquad(tone(80), 'highpass', 300, 0.707)) < 0.15);
  assert.ok(rms(biquad(tone(1000), 'highpass', 300, 0.707)) > 0.6);
});

test('the low-pass removes a high tone', () => {
  assert.ok(rms(biquad(tone(7500), 'lowpass', 6000, 0.707)) < 0.45);
});

test('reverb leaves a tail after the sound stops', () => {
  const x = new Float32Array(16000);
  x.set(tone(500, 0.2));
  const y = reverb(x, 0.4, 0.5);
  assert.ok(rms(y.subarray(4800, 8000)) > 0.005);
});

test('gainDb scales by the decibel ratio', () => {
  assert.ok(Math.abs(rms(gainDb(tone(500), -20)) - rms(tone(500)) / 10) < 1e-3);
});

test('the laptop speaker is deterministic for a seed and quieter than its input', () => {
  const x = tone(800);
  const a = laptopSpeaker(x, 3), b = laptopSpeaker(x, 3);
  assert.deepEqual(a, b);
  assert.ok(rms(a) < rms(x));
});
