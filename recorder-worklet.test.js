import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleChunk } from './recorder-worklet.js';

const EMPTY = new Float32Array(0);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// A linear ramp (value === index) makes linear interpolation exact: the
// resampled value at fractional input position p must equal p itself.
const ramp = (n, offset = 0) => Float32Array.from({ length: n }, (_, i) => offset + i);

test('an integer ratio decimates without interpolation error', () => {
  // 48 kHz -> 16 kHz is ratio 3: every 3rd input sample, exactly.
  const { samples, pending, cursor } = resampleChunk(EMPTY, ramp(9), 3, 0);
  assert.deepEqual(Array.from(samples), [0, 3, 6]);
  // Sample index 9 was never reached (needs index 9 and 10), so one sample
  // (index 8) stays pending with the cursor already past it.
  assert.ok(pending.length <= 2);
  assert.ok(cursor >= 0 && cursor < 3);
});

test('a fractional ratio interpolates linearly, exact on a ramp', () => {
  const { samples } = resampleChunk(EMPTY, ramp(10), 2.5, 0);
  // Output positions are 0, 2.5, 5, 7.5, ... and ramp(p) === p.
  for (let i = 0; i < samples.length; i++) assert.ok(near(samples[i], i * 2.5), `sample ${i}`);
});

test('state carries across chunks: splitting the input changes nothing', () => {
  const whole = resampleChunk(EMPTY, ramp(20), 2.5, 0);

  let pending = EMPTY;
  let cursor = 0;
  let out = [];
  for (const chunk of [ramp(7, 0), ramp(6, 7), ramp(7, 13)]) {
    const step = resampleChunk(pending, chunk, 2.5, cursor);
    out = out.concat(Array.from(step.samples));
    pending = step.pending;
    cursor = step.cursor;
  }

  assert.deepEqual(out.map((v) => Math.round(v * 1e6) / 1e6), Array.from(whole.samples).map((v) => Math.round(v * 1e6) / 1e6));
});

test('a ratio of 1 is the identity (the common, already-16 kHz case)', () => {
  const input = ramp(5);
  const { samples, pending, cursor } = resampleChunk(EMPTY, input, 1, 0);
  assert.deepEqual(Array.from(samples), Array.from(input.subarray(0, 4)), 'the last sample needs a successor to interpolate against');
  assert.equal(pending.length, 1);
  assert.equal(cursor, 0);
});

// Fix round 2: `consumedTo` could exceed `combined.length` at the boundary of
// a 128-sample render quantum (the real size Web Audio delivers) whenever the
// ratio does not evenly divide 128 — 48 kHz and 44.1 kHz both qualify. The
// un-clamped cursor then desynced the interpolation on almost every block,
// both duplicating/dropping samples and drifting the total output length
// (reproduced: 48 kHz, 2 s -> 32250 samples instead of 16000 * 2 = 32000,
// maxDiff ~= 2, the full peak-to-peak range of a unit sine). The hand-picked
// chunk sizes in the "state carries across chunks" test above (7, 6, 7) land
// `consumedTo` exactly on `combined.length` and never exercise the overshoot,
// so this needs its own case driven by the real 128-sample quantum size.
function sine(n, freq, sr) {
  return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / sr));
}

function resampleIn128SampleQuanta(signal, ratio) {
  let pending = EMPTY;
  let cursor = 0;
  let out = [];
  for (let i = 0; i < signal.length; i += 128) {
    const step = resampleChunk(pending, signal.subarray(i, i + 128), ratio, cursor);
    out = out.concat(Array.from(step.samples));
    pending = step.pending;
    cursor = step.cursor;
  }
  return out;
}

function assertQuantizedResampleMatchesWhole(inputRate) {
  const ratio = inputRate / 16000;
  const durationSec = 2;
  const signal = sine(Math.round(durationSec * inputRate), 440, inputRate);

  const whole = Array.from(resampleChunk(EMPTY, signal, ratio, 0).samples);
  const chunked = resampleIn128SampleQuanta(signal, ratio);

  const expected = durationSec * 16000;
  assert.ok(Math.abs(chunked.length - expected) <= 1, `chunked length ${chunked.length} should be ${expected} +/- 1`);
  assert.ok(Math.abs(whole.length - expected) <= 1, `whole-buffer length ${whole.length} should be ${expected} +/- 1`);

  const n = Math.min(whole.length, chunked.length);
  let maxDiff = 0;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(whole[i] - chunked[i]));
  assert.ok(maxDiff < 1e-6, `max difference between whole-buffer and 128-sample-chunked resampling was ${maxDiff}`);
}

test('48 kHz in real 128-sample render quanta matches a single whole-buffer call', () => {
  assertQuantizedResampleMatchesWhole(48000);
});

test('44.1 kHz in real 128-sample render quanta matches a single whole-buffer call', () => {
  assertQuantizedResampleMatchesWhole(44100);
});
