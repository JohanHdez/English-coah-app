// Pure helpers for enrollment. The brief asks for "the raw samples (not the
// segmenter)" gated by "blocks above the segmenter's threshold": capture.js's
// onBlock reports every 100 ms block of the continuous recording regardless of
// phrase boundaries, so there is no preroll, no trailing silence, and no
// MIN_SEG_MS floor to discard a short phrase before enrollment ever sees it —
// voicedMs and concatBlocks both work from that same raw block list.

import { voicedThreshold, CHUNK_MS } from './lib/segmenter.js';

// voicedThreshold (lib/segmenter.js) is the Segmenter's own rule: a block
// voices once its RMS clears 2.5x the noise floor, or 0.008 either way. The
// Segmenter estimates that floor causally — frozen while a phrase is active,
// free to adapt only in the silence between phrases — which works for a
// conversation's turns but not for one continuous enrollment take: there is no
// promised leading silence to seed it from (the fixtures have none), and read
// at a natural pace a whole paragraph rarely leaves the 700 ms gap the
// Segmenter needs to ever let the floor re-settle, so a causal replay either
// locks onto whatever the very first block happened to be or never updates
// again (measured 11.3 s voiced out of a genuine ~30 s reading on
// e2e/fixtures/enroll-paulina-room.wav — under the 12 s gate).
//
// Enrollment has the whole recording in hand before it has to decide, so it
// estimates the floor globally instead: the `percentile`-ranked block stands
// in for "quiet", the way a live Segmenter's between-phrase silence would. But
// that alone still assumes at least `percentile` of the take is genuinely
// quiet — read with few pauses, or with autoGainControl compressing everything
// into a narrow band, it is not: a fully continuous take can leave the
// percentile rank sitting *inside* the spoken range, so 2.5x it rejects most
// of the speech outright (measured: a synthetic 300-block continuous-speech
// series counted 0 ms). Capping the floor at half the recording's own median
// closes that: voicedThreshold's 2.5x multiplier can then never clear the
// median itself, so at least half of any take's loudest blocks stay reachable
// regardless of how little genuine silence it contains, while true silence or
// room noise (median itself near the 0.008 absolute floor) still caps low.
export function voicedMs(blocks, { blockMs = CHUNK_MS, percentile = 0.1 } = {}) {
  if (blocks.length === 0) return 0;
  const sorted = blocks.map((b) => b.rms).sort((a, b) => a - b);
  const rank = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const floor = Math.min(rank(percentile), rank(0.5) / 2.5);
  const threshold = voicedThreshold(floor);
  let count = 0;
  for (const { rms } of blocks) if (rms > threshold) count++;
  return count * blockMs;
}

export function concatBlocks(blocks) {
  const length = blocks.reduce((n, b) => n + b.samples.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const b of blocks) {
    out.set(b.samples, offset);
    offset += b.samples.length;
  }
  return out;
}
