import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, cosine, meanOf, createSpeakers, classify, assign, correct, labelWindows } from './speaker.js';

const near = (a, b) => Math.abs(a - b) < 1e-6;
const ME = [1, 0, 0];
const THEM = [0, 1, 0];
const jitter = (v, d) => v.map((x, i) => x + (i === 2 ? d : 0));

test('normalize and cosine', () => {
  const v = normalize([3, 4, 0]);
  assert.ok(near(v[0], 0.6) && near(v[1], 0.8));
  assert.ok(near(cosine(normalize([1, 0, 0]), normalize([0, 1, 0])), 0));
  assert.ok(near(cosine(v, v), 1));
});

test('meanOf is the normalized mean of normalized vectors', () => {
  const m = meanOf([[2, 0, 0], [0, 5, 0]]);
  assert.ok(near(m[0], Math.SQRT1_2) && near(m[1], Math.SQRT1_2));
});

test('before any other voice is known, the threshold decides', () => {
  const s = createSpeakers(ME);
  assert.equal(classify(s, 'a', jitter(ME, 0.1)).speaker, 'me');
  assert.equal(classify(s, 'b', THEM).speaker, 'them');
});

test('once the other voice has a centre, the nearer centre decides', () => {
  // An explicit threshold, not the calibrated default: the point is the override,
  // not the module's current constant.
  const s = createSpeakers(ME, { rule: 'centres', threshold: 0.5 });
  classify(s, 'b', THEM);
  // Closer to the other voice than to the print, although above the threshold.
  const r = classify(s, 'c', normalize([0.6, 0.8, 0]));
  assert.equal(r.speaker, 'them');
  assert.ok(r.me >= s.threshold);
});

test('hybrid: a turn clearly matching the print is mine whatever the other centre says', () => {
  const s = createSpeakers(ME, { rule: 'hybrid', threshold: 0.9 });
  classify(s, 'b', normalize([0.3, 1, 0]));
  assert.equal(classify(s, 'c', jitter(ME, 0.2)).speaker, 'me');
});

test('a correction moves the turn and the centres follow', () => {
  const s = createSpeakers(ME, { rule: 'centres', threshold: 0.5 });
  classify(s, 'x', normalize([0.45, 0.9, 0]));
  assert.equal(s.turns.get('x').speaker, 'them');
  assert.equal(correct(s, 'x', 'me'), true);
  assert.equal(s.turns.get('x').speaker, 'me');
  assert.equal(correct(s, 'nope', 'me'), false);
});

test('assign records a known speaker', () => {
  const s = createSpeakers(ME);
  assign(s, 'm', THEM, 'them');
  assert.equal(s.turns.get('m').speaker, 'them');
  assert.equal(s.turns.get('m').manual, true);
});

test('labelWindows classifies without recording', () => {
  const s = createSpeakers(ME);
  assert.deepEqual(labelWindows(s, [ME, THEM, ME]), ['me', 'them', 'me']);
  assert.equal(s.turns.size, 0);
});
