import test from 'node:test';
import assert from 'node:assert/strict';
import { liveMode, createPreviewLane, PREVIEW_MAX_MS, PREVIEW_SLOW_ROUNDS, NOTES } from './live-lane.js';

test('liveMode: an installed pack runs the recogniser, with no note', () => {
  assert.deepEqual(liveMode({ lang: 'en-US', availability: 'available', webgpu: true, preview: true }), { kind: 'speech', note: null });
});

test('liveMode: a downloadable pack offers the install, it does not start the preview lane', () => {
  for (const availability of ['downloadable', 'downloading']) {
    const m = liveMode({ lang: 'en-US', availability, webgpu: true, preview: true });
    assert.equal(m.kind, 'install');
    assert.equal(m.note, NOTES.install);
  }
});

test('liveMode: a bilingual meeting says a recogniser hears one language', () => {
  const m = liveMode({ lang: null, availability: 'available', webgpu: true, preview: true });
  assert.deepEqual(m, { kind: 'off', note: NOTES.bilingual });
});

test('liveMode: no on-device recognition, WebGPU and the setting on: the preview lane', () => {
  for (const availability of ['unavailable', 'unsupported', 'unknown']) {
    assert.deepEqual(liveMode({ lang: 'en-US', availability, webgpu: true, preview: true }), { kind: 'preview', note: null });
  }
});

test('liveMode: no on-device recognition and no WebGPU says so in one line', () => {
  const m = liveMode({ lang: 'en-US', availability: 'unavailable', webgpu: false, preview: true });
  assert.deepEqual(m, { kind: 'off', note: NOTES.unavailable });
});

test('liveMode: the lane turned off in Ajustes says that, not that the device cannot', () => {
  const m = liveMode({ lang: 'en-US', availability: 'unsupported', webgpu: true, preview: false });
  assert.deepEqual(m, { kind: 'off', note: NOTES.disabled });
});

test('liveMode: the preview lane is English only, so a Spanish meeting does not get it', () => {
  const m = liveMode({ lang: 'es-ES', availability: 'unsupported', webgpu: true, preview: true });
  assert.deepEqual(m, { kind: 'off', note: NOTES.unavailable });
});

test('NOTES are Spanish, one line each', () => {
  for (const text of Object.values(NOTES)) {
    assert.ok(text.length > 10);
    assert.ok(!text.includes('\n'));
  }
});

// A transcribe() the test resolves by hand, and a clock it moves.
function rig() {
  let clock = 0;
  const calls = [];
  const shown = [];
  const transcribe = (audio) => new Promise((resolve, reject) => calls.push({ audio, resolve, reject }));
  let retired = 0;
  const lane = createPreviewLane({ transcribe, onText: (t) => shown.push(t), now: () => clock, onRetire: () => retired++ });
  return {
    lane, calls, shown,
    tick: (ms) => { clock += ms; },
    retired: () => retired,
    settle: async (text, ms = 300) => { clock += ms; calls.at(-1).resolve(text); await new Promise((r) => setImmediate(r)); },
  };
}

const seg = (startedAt) => ({ audio: new Float32Array(16), startedAt });

test('preview lane: one pass in flight at a time', async () => {
  const r = rig();
  assert.equal(r.lane.canPreview(), true);
  r.lane.offer(seg(1000));
  assert.equal(r.lane.canPreview(), false);
  await r.settle('Hello there my friend');
  assert.equal(r.lane.canPreview(), true);
  assert.deepEqual(r.shown, ['Hello there my friend']);
});

test('preview lane: passes over one piece are stitched, not swapped', async () => {
  const r = rig();
  r.lane.offer(seg(1000));
  await r.settle('Let us start by');
  r.lane.offer(seg(1000));
  await r.settle('Let us start by reviewing the numbers');
  assert.equal(r.shown.at(-1), 'Let us start by reviewing the numbers');
});

test('preview lane: a new piece starts its line from nothing', async () => {
  const r = rig();
  r.lane.offer(seg(1000));
  await r.settle('Let us start by reviewing');
  r.lane.offer(seg(9000));
  await r.settle('the numbers from last week');
  assert.equal(r.shown.at(-1), 'the numbers from last week');
});

test('preview lane: junk passes paint nothing', async () => {
  const r = rig();
  r.lane.offer(seg(1000));
  await r.settle(' you ');
  assert.deepEqual(r.shown, []);
});

test('preview lane: a late pass of a piece that already closed is dropped', async () => {
  const r = rig();
  r.lane.offer(seg(1000));
  r.lane.closed(1000);
  await r.settle('Hello there my friend');
  assert.deepEqual(r.shown, []);
});

test('preview lane: a bubble clears the line only when the line belongs to a closed piece', async () => {
  const r = rig();
  r.lane.offer(seg(1000));
  await r.settle('first piece words');
  r.lane.closed(1000);
  r.lane.offer(seg(5000));
  await r.settle('second piece words');
  r.lane.bubble();
  assert.equal(r.shown.at(-1), 'second piece words', 'the speaker is still talking: the line stands');
  r.lane.closed(5000);
  r.lane.bubble();
  assert.equal(r.shown.at(-1), '');
});

test('preview lane: two consecutive slow passes retire it; a fast one in between resets the count', async () => {
  assert.equal(PREVIEW_MAX_MS, 1500);
  assert.equal(PREVIEW_SLOW_ROUNDS, 2);
  const r = rig();
  r.lane.offer(seg(1000));
  await r.settle('one two three', PREVIEW_MAX_MS + 1);
  r.lane.offer(seg(1000));
  await r.settle('one two three four', 200);
  r.lane.offer(seg(1000));
  await r.settle('one two three four five', PREVIEW_MAX_MS + 1);
  assert.equal(r.retired(), 0);
  assert.equal(r.lane.canPreview(), true);
  r.lane.offer(seg(1000));
  await r.settle('one two three four five six', PREVIEW_MAX_MS + 1);
  assert.equal(r.retired(), 1);
  assert.equal(r.lane.canPreview(), false);
  assert.equal(r.shown.at(-1), '', 'a retired lane blanks its line');
});

test('preview lane: a failed pass stays silent and frees the lane', async () => {
  const r = rig();
  r.lane.offer(seg(1000));
  r.calls[0].reject(new Error('gpu lost'));
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(r.shown, []);
  assert.equal(r.lane.canPreview(), true);
});

test('preview lane: nothing paints after stop()', async () => {
  const r = rig();
  r.lane.offer(seg(1000));
  r.lane.stop();
  await r.settle('Hello there my friend');
  assert.deepEqual(r.shown, ['']);
  assert.equal(r.lane.canPreview(), false);
});
