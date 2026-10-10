// Segment -> speaker -> transcription -> bubble, with every side effect injected
// so this module runs unmodified under node --test. `embed` and `transcribe` are
// async functions the caller binds (to the embed worker and to Groq respectively);
// `speakers` is state from speaker.js the caller owns, so it survives corrections.

import { isJunk, foldIntoTranscript, SR } from './lib/segmenter.js';
import { classify, assign, correct as correctSpeaker, labelWindows, meanOf } from './speaker.js';
import { detect } from './lib/langid.js';

// The extension's rule (offscreen.js at ded2c34): when the engine names no
// language (Gemini always; OpenAI's json models), a bilingual meeting lets the text
// decide, but only on clear evidence — a one-word turn can score 1.0 for either
// language — and otherwise keeps the speaker's last language. A pinned meeting
// has no question to answer.
export const LANG_CONFIDENCE = 0.5;

export function turnLang({ reported, text, sessionLang, previous = null }) {
  if (reported) return reported;
  if (sessionLang === 'multi') {
    const read = detect(text);
    return read.lang && read.confidence >= LANG_CONFIDENCE ? read.lang : previous;
  }
  return sessionLang === 'es' || sessionLang === 'en' ? sessionLang : null;
}

// Step 5b: measurement found 28.5 % of segments mix both voices (the segmenter
// waits 700 ms of silence; people take turns faster). A segment this long or
// longer is re-scanned in overlapping windows to find a handoff the silence gate
// missed.
const SPLIT_MIN_MS = 3000;
const WIN_SECS = 1.5;
const HOP_SECS = 0.75;

// Phone budget (final review, finding 5): the window scan costs about 1.3 s of
// embedding per second of audio. How far embedding trails the speaker is how
// long this segment waited for its turn plus the audio queued behind it; past
// BACKLOG_SKIP_MS, long segments get one whole-segment label until it recovers.
// Measured with e2e/run.mjs --throttle=4: audio queued behind the segment alone
// never passed 7.8 s while bubbles fell 8–9 s behind, because a segment that
// arrived mid-scan is no longer "behind" anything once its own turn comes.
export const BACKLOG_SKIP_MS = 4000;

export function shouldScan(durationMs, backlogMs) {
  return durationMs >= SPLIT_MIN_MS && backlogMs <= BACKLOG_SKIP_MS;
}

// Audio waiting for a transcription slot, in milliseconds. LATE_MS of waiting audio means
// the bubbles already trail the speaker by that much: the UI says so. CAP_MS is
// the most it may hold: a minute of 16 kHz Float32 is 3.8 MB, and a bubble more
// than a minute late is no use in a live conversation, so the oldest waiting
// segment is dropped — visibly, as an error event — rather than letting memory
// and latency grow for the rest of the meeting.
export const LATE_MS = 10000;
export const CAP_MS = 60000;
const MAX_INFLIGHT = 2;

export const DROPPED_MESSAGE = '[transcripción] La transcripción va con retraso: se descartó un fragmento de audio.';
export const LATE_STATUS = 'La transcripción va con retraso…';

// At most `maxInflight` uploads at once; the rest wait in arrival order. Every
// enqueue resolves (never rejects) with { ok, value } | { ok: false, error } |
// { ok: false, dropped: true } (closed, or `signal` aborted, before it started).
// `front` puts the item ahead of everything waiting: the parts of a split segment
// replace an upload that already held an earlier place in line.
export function createUploadQueue({ maxInflight = MAX_INFLIGHT, capMs = CAP_MS, lateMs = LATE_MS, onLate = () => {}, onDrop = () => {} } = {}) {
  let active = 0;
  let waitingMs = 0;
  let late = false;
  let closed = false;
  const waiting = [];

  function setLate(next) {
    if (next === late) return;
    late = next;
    onLate(late);
  }

  function start(item) {
    active++;
    item.started = true;
    item.fn().then(
      (value) => settle(item, { ok: true, value }),
      (error) => settle(item, { ok: false, error }),
    );
  }

  function settle(item, outcome) {
    active--;
    item.resolve(outcome);
    if (waiting.length && !closed) {
      const next = waiting.shift();
      waitingMs -= next.audioMs;
      start(next);
    }
    if (waitingMs < lateMs) setLate(false);
  }

  function withdraw(item) {
    const i = waiting.indexOf(item);
    if (i < 0) return;
    waiting.splice(i, 1);
    waitingMs -= item.audioMs;
    item.resolve({ ok: false, dropped: true });
    if (waitingMs < lateMs) setLate(false);
  }

  function enqueue(fn, audioMs = 0, { signal, front = false } = {}) {
    return new Promise((resolve) => {
      const item = { fn, audioMs, resolve, started: false };
      if (closed || signal?.aborted) { resolve({ ok: false, dropped: true }); return; }
      if (active < maxInflight) { start(item); return; }
      signal?.addEventListener('abort', () => { if (!item.started) withdraw(item); }, { once: true });
      if (front) waiting.unshift(item);
      else waiting.push(item);
      waitingMs += audioMs;
      while (waitingMs > capMs && waiting.length > 1) {
        const oldest = waiting.shift();
        waitingMs -= oldest.audioMs;
        onDrop(oldest.audioMs);
        oldest.resolve({ ok: false, error: new Error(DROPPED_MESSAGE) });
      }
      if (waitingMs >= lateMs) setLate(true);
    });
  }

  function close() {
    closed = true;
    for (const item of waiting.splice(0)) item.resolve({ ok: false, dropped: true });
    waitingMs = 0;
  }

  return { enqueue, close, waitingMs: () => waitingMs, active: () => active };
}

export function createSession({ embed, transcribe, speakers, now = Date.now, onEvent, lang = () => null }) {
  const transcript = [];
  const lastLang = { me: null, them: null };
  let manual = null;
  let seq = 0;
  const nextId = () => seq++;
  let closed = false;
  // Fires on close(): the in-flight uploads and their retries stop, so no meeting
  // audio leaves the device once the meeting is over.
  const aborter = new AbortController();
  // Audio handed to segment() whose labelling has not started yet.
  let queuedEmbedMs = 0;

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
  // Bubbles are painted in capture order, independent of how fast each
  // transcription or label actually comes back.
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
        if (!closed) emitError(err);
      }
    });
  }

  const uploads = createUploadQueue({
    onLate: (late) => safeEmit({ type: 'status', text: late ? LATE_STATUS : '' }),
  });

  // One upload with its own abort: a 5b split replaces it with its parts, and
  // close() stops it with everything else. `state()` is what a cancel wasted:
  // nothing while 'waiting', part of a request while 'inflight', all of it once
  // 'done'.
  function upload({ audio, durationMs }, front = false) {
    const ctl = new AbortController();
    const cancel = () => ctl.abort();
    aborter.signal.addEventListener('abort', cancel, { once: true });
    let state = 'waiting';
    const outcome = uploads.enqueue(() => {
      state = 'inflight';
      return transcribe(audio, ctl.signal);
    }, durationMs, { signal: ctl.signal, front });
    outcome.then(() => {
      if (state === 'inflight') state = 'done';
      aborter.signal.removeEventListener('abort', cancel);
    });
    return { outcome, cancel, state: () => state };
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

  // Labels one audio stretch (embed -> classify/assign) on the label chain.
  // `manualSpeaker` is the mode in force when the *segment* was captured (see
  // segment() below), not whenever this async chain happens to reach it.
  // `vector`, when present, is the mean of the scan's windows over this very
  // audio: embedding it again would cost as much as the scan saved.
  async function labelPart(unit, manualSpeaker) {
    const id = nextId();
    try {
      const vector = unit.part.vector || await embed(unit.part.audio);
      unit.speaker = labelUnit(id, vector, manualSpeaker);
      unit.id = id;
    } catch (err) {
      unit.upload.cancel();
      unit.error = err;
    }
    unit.done();
  }

  function unitOf(part, existing) {
    const unit = { part, upload: existing };
    unit.labelled = new Promise((resolve) => { unit.done = resolve; });
    return unit;
  }

  async function emitUnit(unit) {
    await unit.labelled;
    if (unit.error) throw unit.error;
    const outcome = await unit.upload.outcome;
    if (outcome.dropped || closed) return;
    if (!outcome.ok) throw outcome.error;
    const result = outcome.value;
    if (isJunk(result.text)) return;
    const { startedAt, durationMs } = unit.part;
    const turn = turnLang({ reported: result.lang, text: result.text, sessionLang: lang(), previous: lastLang[unit.speaker] });
    if (turn) lastLang[unit.speaker] = turn;
    foldAndEmit(unit.speaker, result.text, startedAt, durationMs, turn, unit.id);
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
    if (!vectors.length) return [seg];
    const whole = { ...seg, vector: meanOf(vectors) };
    if (vectors.length < 3) return [whole];

    const labels = labelWindows(speakers, vectors);
    const runs = mergeShortRuns(runsOf(labels));
    if (runs.length < 2) return [whole];

    const splitAt = starts[runs[1].startIdx];
    const firstMs = (splitAt / SR) * 1000;
    return [
      { audio: seg.audio.slice(0, splitAt), startedAt: seg.startedAt, durationMs: firstMs },
      { audio: seg.audio.slice(splitAt), startedAt: seg.startedAt + firstMs, durationMs: seg.durationMs - firstMs },
    ];
  }

  // The whole segment's upload starts at once, beside its label: the bubble waits
  // for the slower of the two instead of their sum. If the window scan then
  // splits the segment, the parts' uploads replace it.
  function segment(seg) {
    // Manual mode is a real-time toggle: the speaker in force while this audio
    // was actually captured must stick with it, not whatever is on by the time
    // its embedding (an async step, possibly after a 5b split) finishes.
    const manualAtCapture = manual;
    if (closed) return;
    queuedEmbedMs += seg.durationMs;
    const handedAt = now();
    const whole = upload(seg);
    let resolveUnits;
    const units = new Promise((resolve) => { resolveUnits = resolve; });
    labelChain = labelChain.then(async () => {
      queuedEmbedMs -= seg.durationMs;
      if (closed) { resolveUnits([]); return; }
      const t0 = now();
      const backlogMs = (t0 - handedAt) + queuedEmbedMs;
      const scan = shouldScan(seg.durationMs, backlogMs);
      let list;
      let replaced = null;
      try {
        const parts = scan ? await splitIfNeeded(seg) : [seg];
        if (parts.length > 1) {
          replaced = whole.state();
          whole.cancel();
          list = parts.map((part) => unitOf(part));
          // Reversed so that, put in front one by one, the first part leads.
          for (const unit of [...list].reverse()) unit.upload = upload(unit.part, true);
        } else {
          list = [unitOf(parts[0], whole)];
        }
      } catch (err) {
        whole.cancel();
        list = [{ error: err }];
      }
      // Each part paints as soon as its own label and upload are both in.
      resolveUnits(list);
      for (const unit of list) if (!unit.error) await labelPart(unit, manualAtCapture);
      // Measurement only (the harness records it); the screen ignores it.
      // `replaced` is how far the whole-segment upload had got when a split
      // replaced it ('done' is a wasted request), null when nothing split.
      safeEmit({ type: 'labelled', durationMs: seg.durationMs, embedMs: now() - t0, backlogMs, scanned: scan, replaced });
    });
    queueEmit(async () => {
      for (const unit of await units) {
        try {
          await emitUnit(unit);
        } catch (err) {
          if (!closed) emitError(err);
        }
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
  // labelled, transcribed and painted (or has failed into an error event):
  // segment() grows both chains synchronously, and each emission awaits its own
  // label. A caller that wants a clean "every pending bubble has landed"
  // point (ui/meeting.js's "Terminar", after capture.js's stop() has
  // synchronously flushed the last phrase into one more segment()) awaits this
  // before treating the session as finished.
  function drain() {
    return labelChain.then(() => emitChain);
  }

  // The meeting is over: segments not yet uploaded are dropped, uploads in
  // flight are aborted, and nothing settles into an event after this.
  function close() {
    if (closed) return;
    closed = true;
    uploads.close();
    aborter.abort();
  }

  return { segment, setManual, correct, transcript: () => transcript, drain, close };
}
