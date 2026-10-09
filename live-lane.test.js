import test from 'node:test';
import assert from 'node:assert/strict';
import { liveMode, createPreviewLane, PREVIEW_MAX_MS, PREVIEW_SLOW_ROUNDS, NOTES, isMobile, previewEnabled, deviceFacts } from './live-lane.js';

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

test('liveMode: on a phone the lane waits for the learner to turn it on, and says where', () => {
  const unset = liveMode({ lang: 'en-US', availability: 'unsupported', webgpu: true, preview: undefined, mobile: true });
  assert.deepEqual(unset, { kind: 'off', note: NOTES.optIn });
  assert.ok(/Ajustes/.test(NOTES.optIn) && /120 MB/.test(NOTES.optIn));
  const optedIn = liveMode({ lang: 'en-US', availability: 'unsupported', webgpu: true, preview: true, mobile: true });
  assert.deepEqual(optedIn, { kind: 'preview', note: null });
  const optedOut = liveMode({ lang: 'en-US', availability: 'unsupported', webgpu: true, preview: false, mobile: true });
  assert.deepEqual(optedOut, { kind: 'off', note: NOTES.disabled });
});

test('liveMode: on a desktop an unset setting means the lane runs', () => {
  const m = liveMode({ lang: 'en-US', availability: 'unsupported', webgpu: true, preview: undefined, mobile: false });
  assert.deepEqual(m, { kind: 'preview', note: null });
});

test('previewEnabled: an explicit choice wins; unset follows the device', () => {
  assert.equal(previewEnabled(undefined, false), true);
  assert.equal(previewEnabled(undefined, true), false);
  assert.equal(previewEnabled(true, true), true);
  assert.equal(previewEnabled(false, false), false);
});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const IPAD_OS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

test('isMobile: User-Agent Client Hints decide when the browser has them, except an Android tablet', () => {
  assert.equal(isMobile({ uaDataMobile: true, userAgent: MAC }), true);
  assert.equal(isMobile({ uaDataMobile: false, userAgent: MAC, maxTouchPoints: 0 }), false);
  assert.equal(isMobile({ uaDataMobile: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Mobile', coarse: false, shortSide: 400 }), false);
  assert.equal(isMobile({ uaDataMobile: false, userAgent: MAC, coarse: true, shortSide: 412 }), true);
  assert.equal(isMobile({ uaDataMobile: false, userAgent: MAC, coarse: true, shortSide: 1080 }), false);
  assert.equal(isMobile({ uaDataMobile: false, userAgent: ANDROID_TABLET }), true);
});

test('isMobile: without client hints, the user agent, iPadOS touch, or a small coarse screen', () => {
  assert.equal(isMobile({ userAgent: IPHONE }), true);
  assert.equal(isMobile({ userAgent: ANDROID }), true);
  assert.equal(isMobile({ userAgent: IPAD_OS, maxTouchPoints: 5 }), true);
  assert.equal(isMobile({ userAgent: MAC, maxTouchPoints: 0 }), false);
  assert.equal(isMobile({ userAgent: 'Unknown', coarse: true, shortSide: 400 }), true);
  assert.equal(isMobile({ userAgent: 'Unknown', coarse: true, shortSide: 1080 }), false);
  assert.equal(isMobile({ userAgent: 'Unknown', coarse: false, shortSide: 400 }), false);
});

test('deviceFacts: reads an injected environment', () => {
  const env = {
    navigator: { userAgentData: { mobile: true }, userAgent: MAC, maxTouchPoints: 0 },
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }),
    screen: { width: 390, height: 844 },
  };
  assert.deepEqual(deviceFacts(env), { uaDataMobile: true, userAgent: MAC, maxTouchPoints: 0, coarse: true, shortSide: 390 });
  assert.equal(isMobile(deviceFacts({})), false);
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

test('preview lane: two failed passes in a row retire it, like two slow ones', async () => {
  const r = rig();
  r.lane.offer(seg(1000));
  r.calls[0].reject(new Error('gpu lost'));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.retired(), 0);
  r.lane.offer(seg(1000));
  r.calls[1].reject(new Error('gpu lost'));
  await new Promise((res) => setImmediate(res));
  assert.equal(r.retired(), 1);
  assert.equal(r.lane.canPreview(), false);
});

test('preview lane: nothing paints after stop()', async () => {
  const r = rig();
  r.lane.offer(seg(1000));
  r.lane.stop();
  await r.settle('Hello there my friend');
  assert.deepEqual(r.shown, ['']);
  assert.equal(r.lane.canPreview(), false);
});
