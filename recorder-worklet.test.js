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
