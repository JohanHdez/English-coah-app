import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, blankSpans, liveScore } from './score.mjs';

const manifest = {
  cues: [
    { speaker: 'them', lang: 'en', text: 'Hello there, friend.', start: 0, end: 2 },
    { speaker: 'me', lang: 'en', text: 'Yes.', start: 2.2, end: 3 },
    { speaker: 'them', lang: 'en', text: 'Yes.', start: 3.5, end: 4 },
  ],
};
const full = (c) => ({ cue: c, from: 0, to: manifest.cues[c].text.split(/\s+/).length });
const req = (n, cues, start) => ({ n, slices: cues.map(full), start, score: 0.9, cue: cues[0], arrivalCue: cues[0] });
const bubble = (t, at, speaker, text) => ({ type: 'bubble', t: at, entry: { t, speaker, text } });

test('traces words to cues, labels per cue and times the last word', () => {
  const r = score({
    manifest, micT0: 1000,
    requests: [req(1, [0], 0), req(2, [1], 2.2), req(3, [2], 3.5)],
    events: [
      bubble(1000, 4000, 'them', 'Hello there, friend.'),
      bubble(3200, 4500, 'me', 'Yes.'),
      bubble(4500, 5000, 'me', 'Yes.'),
    ],
  });
  assert.deepEqual(r.perCue.map((c) => c.bubble), ['them', 'me', 'me']);
  assert.equal(r.totals.words, 5);
  assert.equal(Math.round(r.totals.accuracy * 100), 80);
  assert.equal(r.perCue[0].latencyS, (4000 - (1000 + 2000)) / 1000);
  assert.equal(r.totals.mixedBubbles, 0);
});

test('a bubble holding cues of both speakers is mixed; a dropped request is skipped', () => {
  const r = score({
    manifest, micT0: 0,
    requests: [req(1, [0, 1], 0), req(2, [2], 3.5)],
    events: [bubble(0, 100, 'them', 'Hello there, friend. Yes.')],
  });
  assert.equal(r.totals.mixedBubbles, 1);
  assert.equal(r.totals.skippedRequests, 1);
  assert.equal(r.perCue[2].matched, 0);
});

test('a partial slice scores its words and marks the request audio-mixed', () => {
  const r = score({
    manifest, micT0: 0,
    requests: [{ n: 1, start: 0, score: 0.9, cue: 0, arrivalCue: 0, slices: [{ cue: 0, from: 0, to: 3 }, { cue: 1, from: 0, to: 1 }] }],
    events: [bubble(0, 100, 'them', 'Hello there, friend. Yes.')],
  });
  assert.equal(r.totals.audioMixedRequests, 1);
  assert.equal(r.perCue[0].matched, 3);
  assert.equal(r.perCue[1].matched, 1);
});

// Live line: points are { t (ms from t0), text }.
const live = (t, text) => ({ type: 'live', t: 1000 + t, text });
const cues2 = { cues: [
  { speaker: 'them', lang: 'en', text: 'one two three four', start: 1, end: 9 },
  { speaker: 'me', lang: 'en', text: 'five six', start: 10, end: 12 },
] };

test('blankSpans: only holes longer than the grace count; text still standing from before covers a cue', () => {
  const spans = blankSpans([
    { t: 1500, text: 'one' },
    { t: 3000, text: '' },
    { t: 7000, text: 'three' },
  ], cues2);
  assert.deepEqual(spans.map((s) => [s.from, s.to, s.ms]), [[3000, 7000, 4000]]);
  const late = blankSpans([{ t: 4000, text: 'one' }], cues2);
  assert.deepEqual(late.map((s) => [s.from, s.to]), [[1000, 4000]]);
});

test('blankSpans: a cue with no live text at all is one open span', () => {
  const spans = blankSpans([], cues2);
  assert.deepEqual(spans.map((s) => [s.key, s.ms, s.open]), [[0, 8000, true]]);
});

test('liveScore: first live text after onset ignores the previous cue still standing', () => {
  const r = liveScore({
    manifest: cues2, micT0: 1000,
    events: [live(1800, 'one two'), live(9500, 'one two three four'), live(10900, 'five'), live(12500, '')],
  });
  assert.deepEqual(r.perCue.map((c) => c.liveAfterOnsetMs), [800, 900]);
  assert.deepEqual(r.perCue.map((c) => c.coverage), [1, 0.5]);
  assert.equal(r.firstP50, 900);
  assert.equal(r.cuesWithLive, 2);
});

test('liveScore: a cue the line never covered has no onset time', () => {
  const r = liveScore({ manifest: cues2, micT0: 1000, events: [live(1800, 'one two')] });
  assert.deepEqual(r.perCue.map((c) => c.liveAfterOnsetMs), [800, null]);
  assert.equal(r.cuesWithLive, 1);
});
