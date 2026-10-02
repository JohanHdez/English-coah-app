import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score } from './score.mjs';

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
