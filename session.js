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

  // Isolates one onEvent call: a throwing listener (a UI bug) must not corrupt
  // the chains below, and must not stop later segments from painting.
  function safeEmit(event) {
    try {
      onEvent(event);
    } catch {
      // Nothing useful to do with a broken event sink; swallowing here is what
      // keeps the pipeline itself alive.
    }
  }

  function emitError(err) {
    safeEmit({ type: 'error', text: err?.message || String(err) });
  }

  // Embed + classify/assign run one at a time, in capture order: classify()
  // keeps running centre sums, so deciding segment N+1 before N recorded its
  // vote would make the centres (and which ids a correction later touches)
  // depend on network timing instead of capture order. The transcription call
  // itself is not on this chain, so a slow Groq response never blocks the next
  // segment's speaker decision. Every link below catches its own failure: a
  // bare `.then` chain turns one rejection into a permanently rejected chain,
  // silently dropping every segment queued after it.
  let labelChain = Promise.resolve();
  // Bubbles are painted in this same order, independent of how fast each
  // transcription actually comes back (see withLimit below).
  let emitChain = Promise.resolve();

  // Chains `task` onto emitChain so it still runs after every previously
  // queued task, in capture order, but a failure inside `task` (a transcribe
  // rejection forwarded as a throw, or anything fold-related going wrong)
  // becomes an error event instead of poisoning every emission queued after it.
  function queueEmit(task) {
    emitChain = emitChain.then(async () => {
      try {
        await task();
      } catch (err) {
        emitError(err);
      }
    });
  }

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

  function labelUnit(id, vector, manualSpeaker) {
    if (manualSpeaker) {
      assign(speakers, id, vector, manualSpeaker);
      return manualSpeaker;
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
    for (const e of painted) safeEmit({ type: 'bubble', entry: e });
  }

  // One audio stretch through embed -> classify/assign -> transcribe -> fold.
  // `manualSpeaker` is the mode in force when the *segment* was captured (see
  // segment() below), not whenever this async chain happens to reach it.
  async function labelAndDispatch({ audio, startedAt, durationMs }, manualSpeaker) {
    const id = nextId();
    let speaker;
    try {
      const vector = await embed(audio);
      speaker = labelUnit(id, vector, manualSpeaker);
    } catch (err) {
      queueEmit(() => { throw err; });
      return;
    }
    const transcribed = withLimit(() => transcribe(audio));
    queueEmit(async () => {
      const outcome = await transcribed;
      if (!outcome.ok) throw outcome.error;
      const result = outcome.value;
      if (isJunk(result.text)) return;
      foldAndEmit(speaker, result.text, startedAt, durationMs, result.lang, id);
    });
  }

  // Groups consecutive equal labels; `startIdx` is the index into `labels`
  // (and `starts`) where the run begins.
  function runsOf(labels) {
    const runs = [];
    for (let i = 0; i < labels.length; i++) {
      const last = runs.at(-1);
      if (last && last.label === labels[i]) last.length++;
      else runs.push({ label: labels[i], length: 1, startIdx: i });
    }
    return runs;
  }

  // Folds a run shorter than two windows into a neighbour (left when one
  // exists, otherwise right) so an isolated window cannot register as a
  // handoff — alternating labels (me/them/me/them) would otherwise explode
  // into a split at every window instead of staying one segment.
  function mergeShortRuns(runs) {
    const r = runs.map((x) => ({ ...x }));
    while (r.length > 1) {
      const i = r.findIndex((x) => x.length < 2);
      if (i < 0) break;
      if (i > 0) {
        r[i - 1].length += r[i].length;
        r.splice(i, 1);
      } else {
        r[1] = { label: r[1].label, length: r[0].length + r[1].length, startIdx: r[0].startIdx };
        r.splice(0, 1);
      }
    }
    return r;
  }

  // Re-scans a long segment in overlapping windows and, once short runs are
  // folded away, splits at the boundary between the first two surviving runs —
  // whichever side (the opening voice or the one that follows) is the
  // majority. `.slice()` (not `.subarray()`) gives each part its own buffer:
  // the real embed/transcribe functions transfer their input's buffer to a
  // worker or into a fetch body, and transferring a *view* detaches the whole
  // shared buffer underneath it.
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
    const runs = mergeShortRuns(runsOf(labels));
    if (runs.length < 2) return [seg];

    const splitAt = starts[runs[1].startIdx];
    const firstMs = (splitAt / SR) * 1000;
    return [
      { audio: seg.audio.slice(0, splitAt), startedAt: seg.startedAt, durationMs: firstMs },
      { audio: seg.audio.slice(splitAt), startedAt: seg.startedAt + firstMs, durationMs: seg.durationMs - firstMs },
    ];
  }

  function segment(seg) {
    // Manual mode is a real-time toggle: the speaker in force while this audio
    // was actually captured must stick with it, not whatever is on by the time
    // its embedding (an async step, possibly after a 5b split) finishes.
    const manualAtCapture = manual;
    labelChain = labelChain.then(async () => {
      try {
        const parts = seg.durationMs >= SPLIT_MIN_MS ? await splitIfNeeded(seg) : [seg];
        for (const part of parts) await labelAndDispatch(part, manualAtCapture);
      } catch (err) {
        queueEmit(() => { throw err; });
      }
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
    safeEmit({ type: 'bubble', entry });
    return true;
  }

  // Resolves once every segment handed to segment() so far has been embedded,
  // labelled, transcribed and painted (or has failed into an error event) — in
  // that order, since emitChain only grows from inside labelChain's own
  // callbacks. A caller that wants a clean "every pending bubble has landed"
  // point (ui/meeting.js's "Terminar", after capture.js's stop() has
  // synchronously flushed the last phrase into one more segment()) awaits this
  // before treating the session as finished.
  function drain() {
    return labelChain.then(() => emitChain);
  }

  return { segment, setManual, correct, transcript: () => transcript, drain };
}
