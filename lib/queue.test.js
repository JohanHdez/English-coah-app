import test from 'node:test';
import assert from 'node:assert/strict';
import { insertPreview, insertReal, takeNext, MAX_BYPASS, MAX_PREVIEW_BYPASS } from './queue.js';

const real = (speaker, id, extra = {}) => ({ speaker, id, ...extra });
const prev = (speaker, id) => ({ speaker, id, preview: true });
const ids = (queue) => queue.map((s) => s.id);

test('a preview jumps ahead of every queued real segment', () => {
  const q = [real('them', 'r1'), real('me', 'r2')];
  insertPreview(q, { speaker: 'them', id: 'p1' });
  assert.deepEqual(ids(q), ['p1', 'r1', 'r2']);
  assert.ok(q[0].preview, 'the inserted segment must be marked provisional');
});

test('previews keep offer order among themselves', () => {
  const q = [real('them', 'r1')];
  insertPreview(q, { speaker: 'them', id: 'p1' });
  insertPreview(q, { speaker: 'me', id: 'p2' });
  assert.deepEqual(ids(q), ['p1', 'p2', 'r1']);
});

test('a fresher preview replaces the queued one of the same speaker, in place', () => {
  const q = [prev('them', 'p1'), prev('me', 'p2'), real('them', 'r1')];
  insertPreview(q, { speaker: 'them', id: 'p3' });
  assert.deepEqual(ids(q), ['p3', 'p2', 'r1'], 'stale audio must not spend a pass');
});

test('a real segment drops the queued preview of its own speaker only', () => {
  const q = [prev('them', 'p1'), prev('me', 'p2')];
  insertReal(q, real('them', 'r1'));
  assert.deepEqual(ids(q), ['p2', 'r1']);
});

test('a real segment never jumps ahead of a preview', () => {
  const q = [prev('me', 'p1')];
  insertReal(q, real('them', 'r1'));
  assert.deepEqual(ids(q), ['p1', 'r1']);
});

test("a 'them' segment overtakes queued 'me' segments", () => {
  const q = [real('me', 'r1'), real('me', 'r2')];
  insertReal(q, real('them', 'r3'));
  assert.deepEqual(ids(q), ['r3', 'r1', 'r2']);
  assert.equal(q[1].bypassed, 1);
  assert.equal(q[2].bypassed, 1);
});

test("a 'me' segment bypassed MAX_BYPASS times cannot be overtaken again", () => {
  const q = [real('me', 'r1', { bypassed: MAX_BYPASS })];
  insertReal(q, real('them', 'r2'));
  assert.deepEqual(ids(q), ['r1', 'r2']);
});

test("a 'me' segment always queues at the end", () => {
  const q = [prev('them', 'p1'), real('them', 'r1')];
  insertReal(q, real('me', 'r2'));
  assert.deepEqual(ids(q), ['p1', 'r1', 'r2']);
});

// The failure this guards against was measured, not imagined: with two lanes
// offering every PREVIEW_EVERY_MS and a pass costing about as much on a slow
// engine, the front-of-queue preview slot refills before the queue drains, and
// without a budget the first real segment of a busy conversation never runs.
test('sustained preview offers cannot starve a real segment without bound', () => {
  const q = [real('them', 'r1')];
  const ran = [];
  // Drain loop: each cycle the still-talking speaker offers a fresh preview,
  // then the engine takes the head of the queue.
  for (let i = 0; i < 20 && !ran.includes('r1'); i++) {
    insertPreview(q, { speaker: 'them', id: 'p' + i });
    ran.push(q.shift().id);
  }
  const yielded = ran.indexOf('r1');
  assert.ok(yielded >= 0, 'the real segment never ran at all');
  assert.equal(yielded, MAX_PREVIEW_BYPASS,
    `r1 yielded to ${yielded} preview passes, budget is ${MAX_PREVIEW_BYPASS}`);
  assert.ok(q.some((s) => s.preview), 'the live line must keep its lane after the real segment lands');
});

test('replacing a queued preview does not charge the real segment again', () => {
  const q = [real('them', 'r1')];
  insertPreview(q, { speaker: 'them', id: 'p1' });
  insertPreview(q, { speaker: 'them', id: 'p2' });
  insertPreview(q, { speaker: 'them', id: 'p3' });
  assert.deepEqual(ids(q), ['p3', 'r1'], 'one queued slot per speaker');
  assert.equal(q[1].previewBypassed, 1, 'three offers, one slot, one charge');
});

test("order within each voice is never disturbed", () => {
  const q = [];
  insertReal(q, real('me', 'm1'));
  insertReal(q, real('me', 'm2'));
  insertReal(q, real('them', 't1'));
  insertReal(q, real('them', 't2'));
  assert.deepEqual(ids(q), ['t1', 't2', 'm1', 'm2']);
});

test('takeNext removes and returns the first segment the lane wants, leaving the rest in order', () => {
  const queue = [
    { speaker: 'them', preview: true, id: 1 },
    { speaker: 'me', id: 2 },
    { speaker: 'them', preview: true, id: 3 },
    { speaker: 'them', id: 4 },
  ];
  const authoritative = takeNext(queue, (s) => !s.preview);
  assert.equal(authoritative.id, 2);
  assert.deepEqual(queue.map((s) => s.id), [1, 3, 4]);
  const preview = takeNext(queue, (s) => s.preview);
  assert.equal(preview.id, 1);
  assert.deepEqual(queue.map((s) => s.id), [3, 4]);
});

test('takeNext returns null when nothing in the queue is for that lane', () => {
  const queue = [{ speaker: 'them', preview: true, id: 1 }];
  assert.equal(takeNext(queue, (s) => !s.preview), null);
  assert.equal(queue.length, 1);
});
