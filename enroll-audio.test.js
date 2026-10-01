import test from 'node:test';
import assert from 'node:assert/strict';
import { voicedMs, concatBlocks } from './enroll-audio.js';

const blocksOf = (rmsList) => rmsList.map((rms) => ({ rms }));

test('an exactly uniform series counts nothing: nothing is 2.5x itself', () => {
  // A degenerate edge case (zero variance), not a realistic reading — see the
  // continuous-speech test below for the case this module actually has to
  // survive (real speech, even a continuous take, always has some spread).
  assert.equal(voicedMs(blocksOf(Array(10).fill(0.1))), 0);
});

test('N1: a continuous, all-voiced 30 s take still clears the 12 s gate', () => {
  // A smooth 0.05-0.10 ramp: no silence at all, the shape of a fast reading
  // with no pauses, or autoGainControl compressing everything into a narrow
  // band. Before the median/2.5 cap this measured 0 ms (the 10th-percentile
  // rank landed inside the spoken range itself).
  const blocks = blocksOf(Array.from({ length: 300 }, (_, i) => 0.05 + 0.05 * (i / 299)));
  const ms = voicedMs(blocks);
  assert.ok(ms >= 12000, `expected >= 12000, got ${ms}`);
  assert.equal(ms, 14900); // pinned: catches a regression in either direction
});

test('N1: a mostly-silent take with 5 s of real speech measures ~5 s, correctly failing the 12 s gate', () => {
  const blocks = blocksOf([...Array(250).fill(0.001), ...Array(50).fill(0.1)]);
  assert.equal(voicedMs(blocks), 5000);
});

test('voicedMs counts blocks that clear 2.5x the default (10th-percentile) floor', () => {
  // 9 quiet blocks and 1 loud one: the 10th percentile (index 1 of 10) still
  // falls inside the quiet group, so the loud block is what crosses 2.5x it.
  const blocks = blocksOf([...Array(9).fill(0.01), 0.5]);
  assert.equal(voicedMs(blocks), 100);
});

test('the 0.008 absolute floor applies when the percentile floor is very quiet', () => {
  // The 10th-percentile block is 0.001: 2.5x that (0.0025) is below the 0.008
  // absolute minimum, so the slightly-louder block (0.01) still has to clear
  // 0.008, not 0.0025, to count.
  const blocks = blocksOf([...Array(9).fill(0.001), 0.01]);
  assert.equal(voicedMs(blocks), 100);
});

test('the median/2.5 cap keeps the floor in the noise range even when the percentile rank lands on speech', () => {
  // Without the cap, percentile 0.95 would rank the lone loud block itself as
  // "the floor", rejecting it (and everything else) outright — exactly N1's
  // failure mode for a badly-chosen percentile.
  const blocks = blocksOf([...Array(9).fill(0.01), 0.5]);
  assert.equal(voicedMs(blocks, { percentile: 0.95 }), 100);
});

test('voicedMs honours a custom block duration', () => {
  const blocks = blocksOf([...Array(9).fill(0.01), 0.5]);
  assert.equal(voicedMs(blocks, { blockMs: 50 }), 50);
});

test('voicedMs is 0 for no blocks', () => {
  assert.equal(voicedMs([]), 0);
});

test('concatBlocks lays out every block\'s samples in order', () => {
  const blocks = [
    { samples: Float32Array.from([1, 2, 3]) },
    { samples: Float32Array.from([4, 5]) },
    { samples: Float32Array.from([6]) },
  ];
  assert.deepEqual(Array.from(concatBlocks(blocks)), [1, 2, 3, 4, 5, 6]);
});

test('concatBlocks of nothing is an empty Float32Array', () => {
  const out = concatBlocks([]);
  assert.ok(out instanceof Float32Array);
  assert.equal(out.length, 0);
});

test('concatBlocks does not alias the input buffers', () => {
  const a = Float32Array.from([1, 1]);
  const out = concatBlocks([{ samples: a }]);
  out[0] = 99;
  assert.equal(a[0], 1);
});
