// Segment -> speaker -> transcription -> bubble, with every side effect injected
// so this module runs unmodified under node --test. `embed` and `transcribe` are
// async functions the caller binds (to the embed worker and to Groq respectively);
// `speakers` is state from speaker.js the caller owns, so it survives corrections.

import { isJunk, foldIntoTranscript, SR } from './lib/segmenter.js';
import { classify, assign, correct as correctSpeaker, labelWindows } from './speaker.js';

// Step 5b: measurement found 28.5 % of segments mix both voices (the segmenter
// waits 700 ms of silence; people take turns faster). A segment this long or
// longer is re-scanned in overlapping windows to find a handoff the silence gate
// missed.
const SPLIT_MIN_MS = 3000;
const WIN_SECS = 1.5;
const HOP_SECS = 0.75;

export function createSession({ embed, transcribe, speakers, now = Date.now, onEvent }) {
  const transcript = [];
  let manual = null;
  let seq = 0;
  const nextId = () => seq++;

  // Embed + classify/assign run one at a time, in capture order: classify()
  // keeps running centre sums, so deciding segment N+1 before N recorded its
  // vote would make the centres (and which ids a correction later touches)
  // depend on network timing instead of capture order. The transcription call
  // itself is not on this chain, so a slow Groq response never blocks the next
  // segment's speaker decision.
  let labelChain = Promise.resolve();
  // Bubbles are painted in this same order, independent of how fast each
  // transcription actually comes back (see withLimit below).
  let emitChain = Promise.resolve();

  let active = 0;
  const MAX_INFLIGHT = 2;
  const waiting = [];
  function withLimit(fn) {
    return new Promise((resolve) => {
      const start = () => {
        active++;
        const settle = (outcome) => {
          active--;
          if (waiting.length) waiting.shift()();
          resolve(outcome);
        };
        fn().then((value) => settle({ ok: true, value }), (error) => settle({ ok: false, error }));
      };
      if (active < MAX_INFLIGHT) start();
      else waiting.push(start);
    });
  }

  function labelUnit(id, vector) {
    if (manual) {
      assign(speakers, id, vector, manual);
      return manual;
    }
    return classify(speakers, id, vector).speaker;
  }

  // Attaches the segment id to whichever entries foldIntoTranscript touched.
  // foldIntoTranscript (lib/segmenter.js) knows nothing about ids; it returns
  // either our own new entry, the pre-existing bubble it extended (by
  // reference), or a freshly cut-off `opened` entry. Comparing identity against
  // the entry we built and against the transcript's previous last entry tells
  // the three cases apart without re-deriving its branching here.
  function foldAndEmit(speaker, text, startedAt, durationMs, lang, id) {
    const entry = { speaker, text, t: startedAt, dur: durationMs / 1000, lang, segs: [id] };
    let prevLast = null;
    for (const e of transcript) if (!prevLast || e.t > prevLast.t) prevLast = e;
    const painted = foldIntoTranscript(transcript, entry);
    for (const e of painted) {
      if (e === entry) continue; // already carries segs: [id]
      if (e === prevLast) {
        if (!e.segs) e.segs = [];
        if (!e.segs.includes(id)) e.segs.push(id);
      } else {
        e.segs = [id]; // the cut's freshly opened tail
      }
    }
    for (const e of painted) onEvent({ type: 'bubble', entry: e });
  }

  // One audio stretch through embed -> classify/assign -> transcribe -> fold.
  function labelAndDispatch({ audio, startedAt, durationMs }) {
    const id = nextId();
    return embed(audio).then(
      (vector) => {
        const speaker = labelUnit(id, vector);
        const transcribed = withLimit(() => transcribe(audio));
        emitChain = emitChain.then(async () => {
          const outcome = await transcribed;
          if (!outcome.ok) {
            onEvent({ type: 'error', text: outcome.error?.message || String(outcome.error) });
            return;
          }
          const result = outcome.value;
          if (isJunk(result.text)) return;
          foldAndEmit(speaker, result.text, startedAt, durationMs, result.lang, id);
        });
      },
      (err) => {
        emitChain = emitChain.then(() => {
          onEvent({ type: 'error', text: err?.message || String(err) });
        });
      },
    );
  }

  // Re-scans a long segment in overlapping windows and, if two consecutive
  // windows disagree with the majority, splits the audio there. `.slice()`
  // (not `.subarray()`) gives each part its own buffer: the real embed/transcribe
  // functions transfer their input's buffer to a worker or into a fetch body,
  // and transferring a *view* detaches the whole shared buffer underneath it.
  async function splitIfNeeded(seg) {
    const winSamples = Math.round(WIN_SECS * SR);
    const hopSamples = Math.round(HOP_SECS * SR);
    const starts = [];
    const vectors = [];
    for (let start = 0; start + winSamples <= seg.audio.length; start += hopSamples) {
      vectors.push(await embed(seg.audio.slice(start, start + winSamples)));
      starts.push(start);
    }
    if (vectors.length < 3) return [seg];

    const labels = labelWindows(speakers, vectors);
    const counts = { me: 0, them: 0 };
    for (const l of labels) counts[l]++;
    const majority = counts.them > counts.me ? 'them' : 'me';

    let splitAt = -1;
    for (let i = 0; i < labels.length - 1; i++) {
      if (labels[i] !== majority && labels[i + 1] !== majority) { splitAt = starts[i]; break; }
    }
    if (splitAt <= 0) return [seg];

    const firstMs = (splitAt / SR) * 1000;
    return [
      { audio: seg.audio.slice(0, splitAt), startedAt: seg.startedAt, durationMs: firstMs },
      { audio: seg.audio.slice(splitAt), startedAt: seg.startedAt + firstMs, durationMs: seg.durationMs - firstMs },
    ];
  }

  function segment(seg) {
    labelChain = labelChain.then(async () => {
      const parts = seg.durationMs >= SPLIT_MIN_MS ? await splitIfNeeded(seg) : [seg];
      for (const part of parts) await labelAndDispatch(part);
    });
  }

  function setManual(speaker) {
    manual = speaker;
  }

  function correct(bubbleT, speaker) {
    const entry = transcript.find((e) => e.t === bubbleT);
    if (!entry) return false;
    entry.speaker = speaker;
    for (const id of entry.segs || []) correctSpeaker(speakers, id, speaker);
    onEvent({ type: 'bubble', entry });
    return true;
  }

  return { segment, setManual, correct, transcript: () => transcript };
}
