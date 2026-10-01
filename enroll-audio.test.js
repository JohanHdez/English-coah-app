import test from 'node:test';
import assert from 'node:assert/strict';
import { totalVoicedMs, concatSegments } from './enroll-audio.js';

test('totalVoicedMs sums each segment\'s durationMs', () => {
  const segments = [{ durationMs: 1200 }, { durationMs: 3400.5 }, { durationMs: 900 }];
  assert.equal(totalVoicedMs(segments), 5500.5);
});

test('totalVoicedMs is 0 for no segments', () => {
  assert.equal(totalVoicedMs([]), 0);
});

test('concatSegments lays out every segment\'s samples in order', () => {
  const segments = [
    { audio: Float32Array.from([1, 2, 3]) },
    { audio: Float32Array.from([4, 5]) },
    { audio: Float32Array.from([6]) },
  ];
  assert.deepEqual(Array.from(concatSegments(segments)), [1, 2, 3, 4, 5, 6]);
});

test('concatSegments of nothing is an empty Float32Array', () => {
  const out = concatSegments([]);
  assert.ok(out instanceof Float32Array);
  assert.equal(out.length, 0);
});

test('concatSegments does not alias the input buffers', () => {
  const a = Float32Array.from([1, 1]);
  const out = concatSegments([{ audio: a }]);
  out[0] = 99;
  assert.equal(a[0], 1);
});
