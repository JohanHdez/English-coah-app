import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from './session.js';
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
  await sleep(20);

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
  await sleep(20);

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
  await sleep(20);

  const bs = bubbles(events);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].entry.speaker, 'me');
});

test('correct() relabels the bubble and records the correction on every folded segment', async () => {
  const { events, onEvent } = collector();
  const speakers = createSpeakers(ME_LIKE);
  const session = createSession({ embed: fakeEmbed, transcribe: fakeTranscribe([{}]), speakers, onEvent });

  session.segment(seg('them', 0));
  await sleep(20);
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
  await sleep(20);

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
  await sleep(20);

  assert.equal(bubbles(events).length, 0);
  assert.equal(session.transcript().length, 0);
});

// Step 5b: the segmenter's 700 ms silence gate waits longer than real turn-taking,
// so a single segment can straddle a handoff. A segment of 3 s or more is
// re-scanned in 1.5 s windows (0.75 s hop) and cut where two consecutive windows
// disagree with the rest.
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
  await sleep(20);

  const bs = bubbles(events);
  assert.equal(bs.length, 2, 'the segment must split into exactly two parts');
  assert.equal(bs[0].entry.speaker, 'me');
  assert.equal(bs[0].entry.t, 10000, 'the first part keeps the original startedAt');
  assert.equal(bs[1].entry.speaker, 'them');
  assert.equal(bs[1].entry.t, 10000 + (24000 / 16000) * 1000, 'the second part starts at the split offset');
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
  await sleep(20);

  const bs = bubbles(events);
  assert.equal(bs.length, 2, 'a leading minority run must still produce a split');
  assert.equal(bs[0].entry.speaker, 'me');
  assert.equal(bs[0].entry.t, 0);
  assert.equal(bs[1].entry.speaker, 'them');
  assert.equal(bs[1].entry.t, (24000 / 16000) * 1000);
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
  await sleep(20);

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
  await sleep(20);

  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  const bs = bubbles(events);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].entry.speaker, 'me');
});

test("an onEvent that throws once does not stop the next segment's bubble", async () => {
  const events = [];
  let threw = false;
  const onEvent = (e) => {
    if (!threw) { threw = true; throw new Error('ui bug'); }
    events.push(e);
  };
  const speakers = createSpeakers(ME_LIKE);
  const transcribe = fakeTranscribe([{}, {}]);
  const session = createSession({ embed: fakeEmbed, transcribe, speakers, onEvent });

  session.segment(seg('me', 0));
  session.segment(seg('them', 1000));
  await sleep(20);

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
  await sleep(20);

  const bs = bubbles(events);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].entry.speaker, 'me', 'the mode in force at capture time must win');
});
