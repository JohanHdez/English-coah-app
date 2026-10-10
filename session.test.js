import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, createUploadQueue, shouldScan, turnLang, BACKLOG_SKIP_MS, CAP_MS, LATE_MS, LATE_STATUS, DROPPED_MESSAGE } from './session.js';
import { createSpeakers } from './speaker.js';

// The audio's first sample stands in for the speaker: a real embedding is a
// 256-dim vector, but all session.js needs from one is "closer to the learner's
// print or to the other voice's centre", and these two unit vectors drive that
// decision exactly as a real embedding would.
const ME_LIKE = Float32Array.from([1, 0, 0]);
const THEM_LIKE = Float32Array.from([0, 1, 0]);
async function fakeEmbed(audio) {
  return audio[0] > 0 ? ME_LIKE : THEM_LIKE;
}

function seg(speaker, startedAt, { durationMs = 1000, sampleCount = 10, open = false } = {}) {
  const audio = new Float32Array(sampleCount).fill(speaker === 'me' ? 0.5 : -0.5);
  return { audio, startedAt, durationMs, open };
}

// `responses[n]` answers the (n+1)-th call to transcribe(), so a test can make
// an earlier segment resolve after a later one, fail, or come back as junk.
function fakeTranscribe(responses) {
  let i = 0;
  return () => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (spec.error) reject(new Error(spec.error));
        else resolve({ text: spec.text ?? 'Hello there.', lang: spec.lang ?? 'en' });
      }, spec.delay ?? 0);
    });
  };
}

function collector() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

const bubbles = (events) => events.filter((e) => e.type === 'bubble');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a learner segment then an other segment produce two bubbles, me then them', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const session = createSession({ embed: fakeEmbed, transcribe: fakeTranscribe([{}, {}]), speakers, onEvent });

  session.segment(seg('me', 0));
  session.segment(seg('them', 1000));
  await session.drain();

  const bs = bubbles(events);
  assert.equal(bs.length, 2);
  assert.equal(bs[0].entry.speaker, 'me');
  assert.equal(bs[1].entry.speaker, 'them');
});

test('two consecutive other segments fold into one bubble whose segs has both ids', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  // Neither half ends a sentence on its own, so the fold is a plain merge, not
  // a cut at a sentence boundary (two copies of the same full sentence would
  // read as two sentences and rightly split into two bubbles instead).
  const transcribe = fakeTranscribe([{ text: 'I think' }, { text: "that's a good point." }]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  session.segment(seg('them', 0, { durationMs: 1200 }));
  session.segment(seg('them', 1500));
  await session.drain();

  const bs = bubbles(events);
  assert.equal(bs.length, 2, 'one emission per segment processed');
  const last = session.transcript().at(-1);
  assert.equal(session.transcript().length, 1, 'both segments landed in one bubble');
  assert.equal(last.text, "I think that's a good point.");
  assert.equal(last.segs.length, 2);
});

test('manual mode forces "me" for a segment that embeds as the other voice', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const session = createSession({ embed: fakeEmbed, transcribe: fakeTranscribe([{}]), speakers, onEvent });

  session.setManual('me');
  session.segment(seg('them', 0));
  await session.drain();

  const bs = bubbles(events);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].entry.speaker, 'me');
});

test('correct() relabels the bubble and records the correction on every folded segment', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const session = createSession({ embed: fakeEmbed, transcribe: fakeTranscribe([{}]), speakers, onEvent });

  session.segment(seg('them', 0));
  await session.drain();
  const original = session.transcript()[0];
  assert.equal(original.speaker, 'them');
  const [id] = original.segs;

  session.correct(original.t, 'me');

  const last = events.at(-1);
  assert.equal(last.type, 'bubble');
  assert.equal(last.entry.speaker, 'me');
  assert.equal(session.transcript()[0].speaker, 'me');
  assert.equal(speakers.turns.get(id).speaker, 'me');
});

test('a transcription that resolves later than the next one still yields bubbles in capture order', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{ delay: 40 }, { delay: 5 }]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  session.segment(seg('me', 0));
  session.segment(seg('them', 1000));
  await sleep(100);

  const bs = bubbles(events);
  assert.equal(bs.length, 2);
  assert.equal(bs[0].entry.speaker, 'me', 'the first captured segment must still paint first');
  assert.equal(bs[1].entry.speaker, 'them');
});

test('a transcription that throws emits an error and the next segment still produces its bubble', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{ error: 'boom' }, {}]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  session.segment(seg('me', 0));
  session.segment(seg('them', 1000));
  await session.drain();

  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  assert.equal(bubbles(events).length, 1);
  assert.equal(bubbles(events)[0].entry.speaker, 'them');
});

test('a junk transcription produces no bubble', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{ text: 'Thanks for watching!' }]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  session.segment(seg('me', 0));
  await session.drain();

  assert.equal(bubbles(events).length, 0);
  assert.equal(session.transcript().length, 0);
});

// Step 5b: the segmenter's silence gate waits longer than real turn-taking,
// so a single segment can straddle a handoff. A segment of 3 s or more is
// re-scanned in 1.5 s windows (0.75 s hop) and cut where two consecutive windows
// disagree with the rest, half a hop into the first of them.
test('a 4.5 s segment that switches speaker midway is split at the disagreement', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{}, {}]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  // 4.5 s @ 16 kHz = 72000 samples -> windows start at 0, 12000, 24000, 36000, 48000
  // (1.5 s = 24000 samples, 0.75 s hop = 12000 samples). First sample of each
  // window carries the sign fakeEmbed reads, so [me, me, them, them, me] comes
  // from switching sign at sample 24000 (window 2) back to positive at 48000.
  const audio = new Float32Array(72000).fill(0.5);
  audio.fill(-0.5, 24000, 48000);
  session.segment({ audio, startedAt: 10000, durationMs: 4500, open: false });
  await session.drain();

  const bs = bubbles(events);
  assert.equal(bs.length, 2, 'the segment must split into exactly two parts');
  assert.equal(bs[0].entry.speaker, 'me');
  assert.equal(bs[0].entry.t, 10000, 'the first part keeps the original startedAt');
  assert.equal(bs[1].entry.speaker, 'them');
  assert.equal(bs[1].entry.t, 10000 + (30000 / 16000) * 1000, 'the second part starts half a hop into the first window of the new voice');
});

// Fix round 1, finding 2: the previous scan only looked for two consecutive
// *non-majority* windows, so a segment that opens with the shorter run (the
// minority) put the disagreement at window 0 and `splitAt <= 0` bailed out —
// the most common handoff (a short turn, then a longer one) never split.
test('a leading short turn followed by a longer one still splits, minority first', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{}, {}]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  // 4.5 s @ 16 kHz = 72000 samples, windows at 0, 12000, 24000, 36000, 48000.
  // First 1.5 s (24000 samples) is the learner; the rest is the other voice:
  // window labels [me, me, them, them, them] — majority is 'them', but the
  // handoff is still the boundary after window 1.
  const audio = new Float32Array(72000).fill(0.5);
  audio.fill(-0.5, 24000);
  session.segment({ audio, startedAt: 0, durationMs: 4500, open: false });
  await session.drain();

  const bs = bubbles(events);
  assert.equal(bs.length, 2, 'a leading minority run must still produce a split');
  assert.equal(bs[0].entry.speaker, 'me');
  assert.equal(bs[0].entry.t, 0);
  assert.equal(bs[1].entry.speaker, 'them');
  assert.equal(bs[1].entry.t, (30000 / 16000) * 1000);
});

test('alternating window labels do not explode into a split', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{}]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  // Same 4.5 s / 5-window layout, but the sign (and so the label) flips at
  // every window start (0, 12000, 24000, 36000, 48000): every run is one
  // window long, so none of them should register as a real handoff.
  const audio = new Float32Array(72000);
  const signPerChunk = [0.5, -0.5, 0.5, -0.5, 0.5, 0.5]; // 6 chunks of 12000 samples
  signPerChunk.forEach((sign, c) => audio.fill(sign, c * 12000, (c + 1) * 12000));
  session.segment({ audio, startedAt: 0, durationMs: 4500, open: false });
  await session.drain();

  assert.equal(bubbles(events).length, 1, 'alternating windows must stay one segment');
});

// Fix round 1, finding 1: a failure anywhere in the pipeline must emit an
// error and let later segments through, instead of poisoning the chains that
// serialize labelling (labelChain) and emission (emitChain).
test('an embed that rejects during the 5b window scan does not stop later segments', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  let calls = 0;
  const flakyEmbed = async (audio) => {
    calls++;
    if (calls === 1) throw new Error('[huella] boom');
    return audio[0] > 0 ? ME_LIKE : THEM_LIKE;
  };
  const transcribe = fakeTranscribe([{}]);
  const session = createSession({ embed: flakyEmbed, transcribe, speakers, onEvent });

  session.segment({ audio: new Float32Array(72000).fill(0.5), startedAt: 0, durationMs: 4500, open: false });
  session.segment(seg('me', 5000));
  await session.drain();

  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  const bs = bubbles(events);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].entry.speaker, 'me');
});

test("an onEvent that throws once does not stop the next segment's bubble", async () => {
  const events = [];
  let threw = false;
  const onEvent = (e) => {
    if (e.type !== 'bubble') return;
    if (!threw) { threw = true; throw new Error('ui bug'); }
    events.push(e);
  };
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{}, {}]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  session.segment(seg('me', 0));
  session.segment(seg('them', 1000));
  await session.drain();

  const bs = bubbles(events);
  assert.equal(bs.length, 1, "only the second segment's event got through the broken sink");
  assert.equal(bs[0].entry.speaker, 'them');
  assert.equal(session.transcript().length, 2, 'both segments still landed in the transcript itself');
});

// Fix round 1, finding 5: manual mode must be read when the segment is
// captured, not whenever its (async) embedding happens to resolve.
test('manual mode is captured at segment() time, not when the embedding resolves', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowEmbed = async (audio) => { await gate; return audio[0] > 0 ? ME_LIKE : THEM_LIKE; };
  const transcribe = fakeTranscribe([{}]);
  const session = createSession({ embed: slowEmbed, transcribe, speakers, onEvent });

  session.setManual('me');
  session.segment(seg('them', 0)); // embeds as the other voice, but "soy yo" is on
  session.setManual(null); // toggled off before the embedding (and labelling) happen
  release();
  await session.drain();

  const bs = bubbles(events);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].entry.speaker, 'me', 'the mode in force at capture time must win');
});

test('drain() resolves only after every queued segment has produced its bubble', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{ delay: 15 }, { delay: 5 }]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  session.segment(seg('me', 0));
  session.segment(seg('them', 1000));
  await session.drain();

  assert.equal(bubbles(events).length, 2, 'both bubbles landed before drain() resolved');
});

test('drain() also waits out a segment queued by a 5b split', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{ delay: 10 }, { delay: 10 }]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  // Same 4.5 s switch-midway audio as the 5b split test above: splitIfNeeded's
  // window rescan itself awaits several embed() calls before either half ever
  // reaches labelAndDispatch, so this also proves drain() outlasts that scan.
  const audio = new Float32Array(72000).fill(0.5);
  audio.fill(-0.5, 24000, 48000);
  session.segment({ audio, startedAt: 10000, durationMs: 4500, open: false });
  await session.drain();

  assert.equal(bubbles(events).length, 2, 'both split parts resolved before drain() returned');
});

// Final review, finding 5: a no-split segment reuses the mean of its scan
// windows instead of being embedded a second time.
test('a long segment that does not split is embedded once per window, never again in full', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const lengths = [];
  const embed = async (audio) => { lengths.push(audio.length); return audio[0] > 0 ? ME_LIKE : THEM_LIKE; };
  const session = createSession({ embed, transcribe: fakeTranscribe([{}]), speakers, onEvent });

  session.segment({ audio: new Float32Array(72000).fill(-0.5), startedAt: 0, durationMs: 4500, open: false });
  await session.drain();

  assert.deepEqual(lengths, [24000, 24000, 24000, 24000, 24000], 'five 1.5 s windows and no 4.5 s embed');
  assert.equal(bubbles(events).length, 1);
  assert.equal(bubbles(events)[0].entry.speaker, 'them', 'the window mean still decides the label');
});

test('a split segment still embeds each part in full', async () => {
  const speakers = createSpeakers(ME_LIKE);
  const lengths = [];
  const embed = async (audio) => { lengths.push(audio.length); return audio[0] > 0 ? ME_LIKE : THEM_LIKE; };
  const session = createSession({ embed, transcribe: fakeTranscribe([{}, {}]), speakers, onEvent: () => {} });
  const audio = new Float32Array(72000).fill(0.5);
  audio.fill(-0.5, 24000);
  session.segment({ audio, startedAt: 0, durationMs: 4500, open: false });
  await session.drain();
  assert.deepEqual(lengths.slice(5), [30000, 42000]);
});

test('shouldScan: long segments only, and only while the embedding backlog is within real time', () => {
  assert.equal(shouldScan(2999, 0), false);
  assert.equal(shouldScan(3000, 0), true);
  assert.equal(shouldScan(8000, BACKLOG_SKIP_MS), true);
  assert.equal(shouldScan(8000, BACKLOG_SKIP_MS + 1), false);
});

test('a backlog of embedding skips the window scan until it recovers, with no error', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  let clock = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  const embed = async (audio) => {
    if (first) { first = false; await gate; }
    return audio[0] > 0 ? ME_LIKE : THEM_LIKE;
  };
  const session = createSession({ embed, transcribe: fakeTranscribe([{}]), speakers, onEvent, now: () => clock });
  const long = (t) => ({ audio: new Float32Array(72000).fill(0.5), startedAt: t, durationMs: 4500, open: false });
  // The first segment's scan stalls; meanwhile two more arrive, 4.5 s apart.
  session.segment(long(0));
  await sleep(5);
  clock = 4500;
  session.segment(long(4500));
  clock = 9000;
  session.segment(long(9000));
  release();
  await session.drain();
  // The second waited 4.5 s with 4.5 s queued behind it: labelled whole. The
  // third, handed in as the stall cleared, waited nothing: scanned again.
  clock = 20000;
  session.segment(long(20000));
  await session.drain();

  const labelled = events.filter((e) => e.type === 'labelled');
  assert.deepEqual(labelled.map((e) => e.backlogMs), [0, 9000, 0, 0]);
  assert.deepEqual(labelled.map((e) => e.scanned), [true, false, true, true]);
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
});

// Final review, finding 4: the Groq queue was unbounded.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('the upload queue runs two at a time, in order', async () => {
  const q = createUploadQueue();
  const started = [];
  const jobs = [0, 1, 2, 3].map(() => deferred());
  const outcomes = jobs.map((job, i) => q.enqueue(() => { started.push(i); return job.promise; }, 1000));
  assert.deepEqual(started, [0, 1]);
  jobs[0].resolve('a');
  await sleep(1);
  assert.deepEqual(started, [0, 1, 2]);
  jobs[1].reject(new Error('x'));
  jobs[2].resolve('c');
  jobs[3].resolve('d');
  const out = await Promise.all(outcomes);
  assert.deepEqual(out.map((o) => o.ok), [true, false, true, true]);
  assert.equal(out[0].value, 'a');
});

test('past the cap the oldest waiting segment is dropped with an error, and late is reported', async () => {
  const late = [];
  const dropped = [];
  const q = createUploadQueue({ onLate: (v) => late.push(v), onDrop: (ms) => dropped.push(ms) });
  const hold = deferred();
  q.enqueue(() => hold.promise, 8000);
  q.enqueue(() => hold.promise, 8000);
  const waiting = [];
  for (let i = 0; i < 9; i++) waiting.push(q.enqueue(async () => 'ok', 8000));
  assert.ok(q.waitingMs() <= CAP_MS, `holds ${q.waitingMs()} ms`);
  assert.deepEqual(dropped, [8000, 8000], '72 s queued, two oldest 8 s segments dropped to fit 60 s');
  assert.deepEqual(late, [true], `late once waiting audio reached ${LATE_MS} ms`);
  const first = await waiting[0];
  assert.equal(first.ok, false);
  assert.equal(first.error.message, DROPPED_MESSAGE);
  hold.resolve('done');
  const rest = await Promise.all(waiting.slice(2));
  assert.ok(rest.every((o) => o.ok));
  assert.deepEqual(late, [true, false], 'recovered once the queue emptied');
});

test('close() drops every waiting upload silently and refuses new ones', async () => {
  const q = createUploadQueue();
  const hold = deferred();
  let ran = 0;
  q.enqueue(() => hold.promise);
  q.enqueue(() => hold.promise);
  const parked = q.enqueue(async () => { ran++; });
  q.close();
  assert.deepEqual(await parked, { ok: false, dropped: true });
  assert.deepEqual(await q.enqueue(async () => { ran++; }), { ok: false, dropped: true });
  hold.resolve();
  await sleep(1);
  assert.equal(ran, 0, 'nothing started after close');
});

test('session.close() aborts in-flight uploads, drops queued ones, and emits nothing after', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const signals = [];
  let calls = 0;
  const transcribe = (audio, signal) => {
    calls++;
    signals.push(signal);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  };
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });
  for (let i = 0; i < 4; i++) session.segment(seg('me', i * 1000));
  await sleep(10);
  assert.equal(calls, 2, 'two in flight, two waiting');
  session.close();
  await session.drain();
  session.segment(seg('me', 9000));
  await sleep(10);
  assert.equal(calls, 2, 'nothing was uploaded after close');
  assert.ok(signals.every((s) => s.aborted));
  assert.equal(events.filter((e) => e.type === 'error' || e.type === 'bubble').length, 0);
});

test('a session whose Groq backs up says so through a status event', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const hold = deferred();
  const session = createSession({ embed: fakeEmbed, transcribe: () => hold.promise.then(() => ({ text: 'Hi.', lang: 'en' })), speakers, onEvent });
  for (let i = 0; i < 6; i++) session.segment(seg('me', i * 3000, { durationMs: 2900 }));
  await sleep(10);
  assert.deepEqual(events.filter((e) => e.type === 'status').map((e) => e.text), [LATE_STATUS]);
  hold.resolve();
  await session.drain();
  assert.deepEqual(events.filter((e) => e.type === 'status').map((e) => e.text), [LATE_STATUS, '']);
});

// Phase 2, Task 2: the upload no longer waits for the voice print.
test('a segment costs the slower of embed and transcribe, not their sum', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const embed = async (audio) => { await sleep(80); return audio[0] > 0 ? ME_LIKE : THEM_LIKE; };
  const session = createSession({ embed, transcribe: fakeTranscribe([{ delay: 80 }]), speakers, onEvent });
  const t0 = performance.now();
  session.segment(seg('me', 0));
  await session.drain();
  const took = performance.now() - t0;
  assert.equal(bubbles(events).length, 1);
  assert.ok(took >= 78 && took < 155, `took ${took.toFixed(0)} ms; in series it would be 160`);
});

test('the upload starts before the embedding has finished', { timeout: 5000 }, async () => {
  const speakers = createSpeakers(ME_LIKE);
  const gate = deferred();
  let uploaded = 0;
  const embed = async (audio) => { await gate.promise; return audio[0] > 0 ? ME_LIKE : THEM_LIKE; };
  const transcribe = async () => { uploaded++; return { text: 'Hello there.', lang: 'en' }; };
  const session = createSession({ embed, transcribe, speakers, onEvent: () => {} });
  session.segment(seg('me', 0));
  await sleep(1);
  assert.equal(uploaded, 1);
  gate.resolve();
  await session.drain();
});

test('a slow label on the first segment still paints it before a quick second one', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  let calls = 0;
  const embed = async (audio) => { if (calls++ === 0) await sleep(40); return audio[0] > 0 ? ME_LIKE : THEM_LIKE; };
  const session = createSession({ embed, transcribe: fakeTranscribe([{ delay: 1 }, { delay: 1 }]), speakers, onEvent });
  session.segment(seg('me', 0));
  session.segment(seg('them', 1000));
  await session.drain();
  assert.deepEqual(bubbles(events).map((e) => e.entry.speaker), ['me', 'them']);
});

// Same 4.5 s switch-midway audio as the 5b tests: the whole segment's upload is
// asked for first, then each part's, and only the parts may reach a bubble.
function splitAudio() {
  const audio = new Float32Array(72000).fill(0.5);
  audio.fill(-0.5, 24000);
  return audio;
}

test('a split replaces a whole-segment upload that already finished, and says so', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const embed = async (audio) => { await sleep(5); return audio[0] > 0 ? ME_LIKE : THEM_LIKE; };
  const transcribe = async (audio) => ({ text: audio.length === 72000 ? 'Whole segment.' : `Part of ${audio.length}.`, lang: 'en' });
  const session = createSession({ embed, transcribe, speakers, onEvent });
  session.segment({ audio: splitAudio(), startedAt: 0, durationMs: 4500, open: false });
  await session.drain();
  const texts = session.transcript().map((e) => e.text);
  assert.deepEqual(texts, ['Part of 30000.', 'Part of 42000.']);
  assert.equal(events.find((e) => e.type === 'labelled').replaced, 'done');
});

test('a split aborts a whole-segment upload still in flight', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  let wholeSignal = null;
  const transcribe = (audio, signal) => {
    if (audio.length !== 72000) return Promise.resolve({ text: 'Part.', lang: 'en' });
    wholeSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  };
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });
  session.segment({ audio: splitAudio(), startedAt: 0, durationMs: 4500, open: false });
  await session.drain();
  assert.ok(wholeSignal.aborted);
  assert.equal(events.find((e) => e.type === 'labelled').replaced, 'inflight');
  assert.equal(bubbles(events).length, 2);
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
});

test('a split withdraws a whole-segment upload still waiting, and its parts go first', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const hold = deferred();
  const seen = [];
  let calls = 0;
  const transcribe = async (audio) => {
    seen.push(audio.length);
    if (calls++ < 2) await hold.promise;
    return { text: 'Hello there.', lang: 'en' };
  };
  const embed = async (audio) => { await sleep(1); return audio[0] > 0 ? ME_LIKE : THEM_LIKE; };
  const session = createSession({ embed, transcribe, speakers, onEvent });
  session.segment(seg('them', 0, { sampleCount: 100 }));
  session.segment(seg('them', 1000, { sampleCount: 101 }));
  session.segment({ audio: splitAudio(), startedAt: 2000, durationMs: 4500, open: false });
  session.segment(seg('me', 7000, { sampleCount: 102 }));
  await sleep(40);
  hold.resolve();
  await session.drain();
  assert.deepEqual(seen, [100, 101, 30000, 42000, 102], 'the whole 72000 never uploaded; its parts kept its place');
  assert.equal(events.find((e) => e.type === 'labelled' && e.durationMs === 4500).replaced, 'waiting');
});

test('an embed failure aborts that upload, emits one error, and the next segment still paints', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  let calls = 0;
  const embed = async (audio) => { if (calls++ === 0) throw new Error('[huella] boom'); return audio[0] > 0 ? ME_LIKE : THEM_LIKE; };
  const signals = [];
  const transcribe = (audio, signal) => { signals.push(signal); return new Promise((r) => setTimeout(() => r({ text: 'Hello there.', lang: 'en' }), 10)); };
  const session = createSession({ embed, transcribe, speakers, onEvent });
  session.segment(seg('me', 0));
  session.segment(seg('them', 1000));
  await session.drain();
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  assert.deepEqual(bubbles(events).map((e) => e.entry.speaker), ['them']);
  assert.deepEqual(signals.map((s) => s.aborted), [true, false]);
});

test('an aborted waiting upload leaves the queue without running and frees its audio', { timeout: 5000 }, async () => {
  const q = createUploadQueue();
  const hold = deferred();
  q.enqueue(() => hold.promise, 1000);
  q.enqueue(() => hold.promise, 1000);
  const ctl = new AbortController();
  let ran = false;
  const parked = q.enqueue(async () => { ran = true; }, 5000, { signal: ctl.signal });
  assert.equal(q.waitingMs(), 5000);
  ctl.abort();
  assert.deepEqual(await parked, { ok: false, dropped: true });
  assert.equal(q.waitingMs(), 0);
  hold.resolve();
  await sleep(1);
  assert.equal(ran, false);
});

test('an upload put in front runs before the ones already waiting', async () => {
  const q = createUploadQueue({ maxInflight: 1 });
  const hold = deferred();
  const order = [];
  q.enqueue(() => hold.promise);
  const a = q.enqueue(async () => order.push('a'));
  const b = q.enqueue(async () => order.push('b'), 0, { front: true });
  hold.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['b', 'a']);
});

// Final review, I2: Gemini names no language, so a bilingual meeting reads it from the text.
test('turnLang: a language the engine reported always wins', () => {
  assert.equal(turnLang({ reported: 'en', text: 'Hola, ¿cómo están todos?', sessionLang: 'multi' }), 'en');
});

test('turnLang: a bilingual meeting reads clear Spanish and clear English from the text', () => {
  assert.equal(turnLang({ reported: null, text: 'Creo que el proyecto está muy bien, pero hay que revisarlo.', sessionLang: 'multi' }), 'es');
  assert.equal(turnLang({ reported: null, text: 'I think the project is going well, but we need to review it.', sessionLang: 'multi' }), 'en');
});

test('turnLang: weak evidence keeps the speaker\'s previous language', () => {
  assert.equal(turnLang({ reported: null, text: 'Kubernetes.', sessionLang: 'multi', previous: 'es' }), 'es');
  assert.equal(turnLang({ reported: null, text: 'Kubernetes.', sessionLang: 'multi' }), null);
});

test('turnLang: a pinned meeting is its own language, whatever the text looks like', () => {
  assert.equal(turnLang({ reported: null, text: 'Gracias por todo.', sessionLang: 'en' }), 'en');
  assert.equal(turnLang({ reported: null, text: 'Thanks.', sessionLang: 'es' }), 'es');
  assert.equal(turnLang({ reported: null, text: 'Thanks.' }), null);
});

test('a bilingual meeting with an engine that names no language tags each bubble from its text', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const texts = [
    'Creo que el proyecto está muy bien, pero hay que revisarlo.',
    'I think the project is going well, but we need to review it.',
    'Kubernetes.',
  ];
  let i = 0;
  const transcribe = async () => ({ text: texts[i++], lang: null });
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent, lang: () => 'multi' });
  session.segment(seg('them', 0));
  await session.drain();
  session.segment(seg('me', 2000));
  await session.drain();
  session.segment(seg('them', 4000));
  await session.drain();
  const last = new Map();
  for (const e of bubbles(events)) last.set(e.entry.t, e.entry);
  const entries = [...last.values()].sort((a, b) => a.t - b.t);
  assert.deepEqual(entries.map((e) => [e.speaker, e.lang]), [['them', 'es'], ['me', 'en'], ['them', 'es']]);
  assert.deepEqual(session.transcript().map((e) => e.lang), ['es', 'en', 'es']);
});

// Phase 3, Task 1 (a): a window labelled with the new voice starts at most one
// hop after the change and the window before it still held the old voice for
// most of its length, so the change lies within that hop: the cut goes to its
// middle. The embed here labels a window by the majority of its samples, as a
// real one roughly does.
test('a split cuts at the middle of the hop where the voice changes', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const majority = async (audio) => (audio.reduce((n, x) => n + x, 0) > 0 ? ME_LIKE : THEM_LIKE);
  const session = createSession({ embed: majority, transcribe: fakeTranscribe([{}, {}]), speakers, onEvent });

  // 4.5 s, the voice changes at 29000 samples. Windows at 0, 12000, 24000, …:
  // [12000, 36000) is mostly the learner, [24000, 48000) mostly the other voice.
  const audio = new Float32Array(72000).fill(0.5);
  audio.fill(-0.5, 29000);
  session.segment({ audio, startedAt: 0, durationMs: 4500, open: false });
  await session.drain();

  const bs = bubbles(events);
  assert.deepEqual(bs.map((e) => e.entry.speaker), ['me', 'them']);
  assert.equal(bs[1].entry.t, ((24000 + 6000) / 16000) * 1000, 'the cut is half a hop after the first window of the new voice');
});

// (b): every change of voice that survives the two-window minimum cuts the segment.
test('a segment that changes voice twice is split into three parts', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const session = createSession({ embed: fakeEmbed, transcribe: fakeTranscribe([{}, {}, {}]), speakers, onEvent });

  // 7.5 s = 120000 samples, windows at 0 … 96000. First samples give
  // [me, me, me, them, them, them, them, me, me].
  const audio = new Float32Array(120000).fill(0.5);
  audio.fill(-0.5, 36000, 84000);
  session.segment({ audio, startedAt: 0, durationMs: 7500, open: false });
  await session.drain();

  const bs = bubbles(events);
  assert.deepEqual(bs.map((e) => e.entry.speaker), ['me', 'them', 'me']);
  assert.deepEqual(bs.map((e) => e.entry.t), [0, (42000 / 16000) * 1000, (90000 / 16000) * 1000]);
  const parts = session.transcript().map((e) => e.dur);
  assert.equal(parts.reduce((n, d) => n + d, 0), 7.5, 'the parts add up to the segment');
});

// (b): a lone window folded into its neighbour leaves two runs of the same
// voice; they are one voice, not a change.
test('a lone window between two runs of one voice does not split the segment', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const lengths = [];
  const embed = async (audio) => { lengths.push(audio.length); return fakeEmbed(audio); };
  const session = createSession({ embed, transcribe: fakeTranscribe([{}]), speakers, onEvent });

  // 6 s = 96000 samples, windows at 0 … 72000: [me, me, me, them, me, me, me].
  const audio = new Float32Array(96000).fill(0.5);
  audio.fill(-0.5, 36000, 48000);
  session.segment({ audio, startedAt: 0, durationMs: 6000, open: false });
  await session.drain();

  assert.equal(bubbles(events).length, 1);
  assert.equal(lengths.length, 7, 'seven windows and no part embedded again');
});
