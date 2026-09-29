// Voice segmentation (simple energy VAD) and audio helpers.

export const SR = 16000;         // working sample rate
export const CHUNK_MS = 100;     // block size the worklet delivers
export const SILENCE_MS = 700;   // silence that closes a phrase
// Forced cut. A speaker who never dips below SOFT_SILENCE_MS would otherwise hold
// one segment for this long and see nothing of it until it ends. Pieces fold into
// one bubble downstream (foldIntoTranscript), so a shorter ceiling costs nothing on
// screen — it only bounds how late the first words of a monologue can be.
export const MAX_SEG_MS = 8000;
// A fast speaker without real pauses would otherwise produce one giant paragraph
// that only appears (and gets translated) when they finally stop. Once a phrase
// is SOFT_CUT_MS long, a mere breath dip of SOFT_SILENCE_MS closes it, so long
// monologues stream out as readable 4-6 s pieces instead.
export const SOFT_CUT_MS = 3500;
export const SOFT_SILENCE_MS = 300;
// The provisional lane: while a phrase is still open, a copy of the audio so far
// is offered for a throwaway transcription, so the English shows up in about a
// second instead of waiting for the phrase to close. Nothing here is stored.
export const PREVIEW_EVERY_MS = 1200;
// After every cut this is dead time: the new phrase shows nothing until it has
// this much speech in it. Set to the floor MIN_VOICED already imposes
// (MIN_VOICED * CHUNK_MS), which is what actually gates the first preview —
// measured, see the test. A larger value here is a second, hidden floor that
// buys nothing today and would silently swallow the gain the day MIN_VOICED is
// lowered to cut the wait.
export const PREVIEW_MIN_MS = 500;
// Only the tail is provisional news. Sending the whole phrase meant every pass over
// a monologue cost more than the last, until they crossed PREVIEW_MAX_MS twice and
// the lane retired itself — so the longer somebody talked, the more certain the
// learner was to lose the live line exactly when they needed it. The head is
// already on screen from the previous pass, and the authoritative segment carries
// the whole phrase anyway.
export const PREVIEW_TAIL_MS = 8000;
export const MIN_SEG_MS = 900;   // discards noise and lone filler sounds
export const MIN_VOICED = 5;     // minimum voiced blocks (0.5 s of real speech)
export const PREROLL = 3;        // preceding blocks kept as preroll

export class Segmenter {
  constructor(speaker, onSegment, now = () => Date.now(), opts = {}) {
    this.speaker = speaker;
    this.onSegment = onSegment;
    this.now = now;
    this.minSegMs = opts.minSegMs ?? MIN_SEG_MS;
    this.minVoiced = opts.minVoiced ?? MIN_VOICED;
    this.onPreview = opts.onPreview || null;
    this.previewEveryMs = opts.previewEveryMs ?? PREVIEW_EVERY_MS;
    this.previewMinMs = opts.previewMinMs ?? PREVIEW_MIN_MS;
    this.previewTailMs = opts.previewTailMs ?? PREVIEW_TAIL_MS;
    this.canPreview = opts.canPreview || null;
    this.lastPreviewAt = null;
    this.floor = null;
    this.pre = [];
    this.chunks = [];
    this.voicedCount = 0;
    this.silence = 0;
    this.active = false;
    // Whether the current piece continues a phrase a cut split, rather than
    // starting at a real onset. The minimum-length rules exist for stray sounds
    // between phrases; the tail of a phrase the segmenter itself cut is speech.
    this.continued = false;
    this.startedAt = 0;
  }

  push({ samples, rms }) {
    // Adaptive noise floor: only updated outside a phrase, so a long utterance
    // cannot raise the threshold until it cuts itself off.
    if (this.floor === null) this.floor = rms;
    else if (!this.active) {
      this.floor = rms < this.floor ? this.floor * 0.85 + rms * 0.15 : this.floor * 0.98 + rms * 0.02;
    }

    const threshold = Math.max(this.floor * 2.5, 0.008);
    const voiced = rms > threshold;

    if (!this.active) {
      this.pre.push(samples);
      if (this.pre.length > PREROLL) this.pre.shift();
      if (voiced) {
        this.active = true;
        this.chunks = this.pre.slice();
        this.pre = [];
        this.voicedCount = 1;
        this.silence = 0;
        this.continued = false;
        this.startedAt = this.now() - this.chunks.length * CHUNK_MS;
      }
      return;
    }

    this.chunks.push(samples);
    if (voiced) { this.voicedCount++; this.silence = 0; }
    else this.silence += CHUNK_MS;

    const durationMs = this.chunks.length * CHUNK_MS;
    const softCut = durationMs >= SOFT_CUT_MS && this.silence >= SOFT_SILENCE_MS;
    if (this.silence >= SILENCE_MS) this.flush();
    else if (softCut || durationMs >= MAX_SEG_MS) this.flush(true);
    // Only when nothing closed the phrase: on a cut the authoritative segment is
    // already on its way, and a provisional copy of the same audio would just
    // flicker on screen before being replaced.
    else this.preview(durationMs);
  }

  // A throwaway snapshot of the phrase in progress. It is a copy, not the live
  // chunks: the transcription path transfers the buffer it receives, and the real
  // segment still needs every sample.
  preview(durationMs) {
    if (!this.onPreview) return;
    // Never on a silent block: the audio it would carry is about to be delivered
    // by the real segment, and a phrase too short to preview would sneak one in
    // as its closing silence pushed the duration past the floor.
    if (this.silence > 0) return;
    if (durationMs < this.previewMinMs || this.voicedCount < this.minVoiced) return;
    const at = this.now();
    if (this.lastPreviewAt !== null && at - this.lastPreviewAt < this.previewEveryMs) return;
    // Ask before doing the work, and do not spend the slot on an offer the engine
    // cannot take. Stamping first meant a preview refused because the engine was
    // busy — which it always is just after a cut — cost a full previewEveryMs of
    // blank line, and then the next one too. That is the stutter.
    if (this.canPreview && !this.canPreview()) return;
    this.lastPreviewAt = at;
    this.onPreview({
      speaker: this.speaker,
      audio: tail(this.chunks, Math.round((this.previewTailMs / 1000) * SR)),
      startedAt: this.startedAt,
      durationMs,
    });
  }

  // keepActive: a mid-utterance emission (soft or hard cut). The segmenter stays
  // inside the phrase, which keeps the adaptive floor frozen — a breath dip has
  // more energy than true ambient, and letting the floor adapt at every cut of a
  // long monologue ratchets the threshold up until quiet word onsets stop
  // crossing it. Only a real pause returns to idle.
  flush(keepActive = false) {
    if (!this.active) return;
    const durationMs = this.chunks.length * CHUNK_MS;
    const chunks = this.chunks;
    const startedAt = this.startedAt;
    const voiced = this.voicedCount;
    const continued = this.continued;
    this.chunks = [];
    this.voicedCount = 0;
    // Each piece previews on its own: the next one starts from nothing and is due
    // as soon as it is long enough, not previewEveryMs after the previous cut.
    this.lastPreviewAt = null;
    if (keepActive) {
      // The next piece starts at the cut; the silence counter keeps running so
      // a dip that turns into a real pause still closes (the near-empty stub is
      // then discarded by the minimum-length rules).
      this.startedAt = this.now();
      this.continued = true;
    } else {
      this.active = false;
      this.pre = [];
      this.silence = 0;
      this.continued = false;
    }

    if (continued ? voiced === 0 : (durationMs < this.minSegMs || voiced < this.minVoiced)) return;

    // `open`: the speaker had not paused — the cut was soft or forced, and more of
    // the same phrase is on its way. The consumer must not treat it as an ending.
    this.onSegment({ speaker: this.speaker, audio: concat(chunks), startedAt, durationMs, open: keepActive });
  }
}

// Whole blocks from the end until the window is covered, so the cost of a pass
// stops growing with the length of the phrase.
function tail(chunks, maxSamples) {
  let total = 0;
  let i = chunks.length;
  while (i > 0 && total < maxSamples) total += chunks[--i].length;
  return concat(i === 0 ? chunks : chunks.slice(i));
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Converts mono Float32 to 16-bit PCM WAV (for the Groq API).
export function floatToWav(samples, sampleRate = SR) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// Interjections and hesitation sounds: "Hmm", "Ooh", "ahh", "Mm"… They add nothing
// to the transcript and clutter the report.
const FILLERS = /^(h+m+|m+h*|u+h+|u+m+|a+h+|o+h+|o+u*h+|e+h+|e+r+|mhm|uh[- ]?huh|huh|hm+m*|aja|ajá)$/i;

export function isJunk(text) {
  const t = (text || '').trim();
  if (!t) return true;

  const junk = /^[\s.,!?¿¡"'\-–—]*(you|thank you\.?|thanks for watching[.!]?|bye[.!]?|\[.*\]|\(.*\))?[\s.,!?"'.]*$/i;
  if (junk.test(t)) return true;

  // A single "word" that is nothing but a hesitation sound.
  const bare = t.replace(/[\s.,!?¿¡"'\-–—…]/g, '');
  if (!bare) return true;
  if (bare.length <= 2 && !/^(no|ok|hi|so|i|a|do|go|up|we|he|it)$/i.test(bare)) return true;
  return FILLERS.test(bare);
}

// The VAD cuts by silence, not by ideas: a thinking pause splits one thought into
// two segments, and each half would be shown — and translated — on its own.
// Consecutive entries of the same speaker within MERGE_GAP_MS fold into the
// previous turn (until it reaches MERGE_MAX_CHARS). A folded turn is cut at its
// last finished sentence: the head stays as the turn it was, closed for good, and
// the tail opens a new turn that later pieces fold into. A bubble that keeps
// growing is retranslated whole every time a piece lands, so this bounds what a
// repaint costs and keeps a finished idea from moving under the reader.
export const MERGE_GAP_MS = 7000;
export const MERGE_MAX_CHARS = 400;

// A sentence end followed by more text: the terminal mark, any closing quote or
// bracket, whitespace, then a sentence opener. Whisper capitalises sentence starts,
// and requiring the opener is what keeps "1.5 million" and "fine. go ahead" whole.
const SENTENCE_END = /[.!?…]["”'’)\]]*\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/g;

// Index where the tail after the last finished sentence begins, or -1 when the
// text has no sentence end that leaves a tail.
export function sentenceCut(text) {
  let cut = -1;
  for (const m of String(text || '').matchAll(SENTENCE_END)) cut = m.index + m[0].length;
  return cut;
}

// Compares against the chronologically latest entry, not the last appended one:
// the transcription queue lets 'them' overtake 'me', so append order can disagree
// with capture order. Returns the entries the UIs should paint, in order — only
// those whose text changed.
export function foldIntoTranscript(transcript, entry, gapMs = MERGE_GAP_MS, maxChars = MERGE_MAX_CHARS) {
  let last = null;
  for (const e of transcript) if (!last || e.t > last.t) last = e;
  const follows = last && last.speaker === entry.speaker
    && entry.t >= last.t
    // One bubble carries one language, because it carries one translation. An entry
    // with no lang predates the field and matches anything, so an old transcript
    // folds exactly as it used to.
    && (!last.lang || !entry.lang || last.lang === entry.lang)
    && entry.t - (last.t + last.dur * 1000) <= gapMs;
  const merged = follows ? `${last.text} ${entry.text}`.trim() : '';
  const cut = follows ? sentenceCut(merged) : -1;
  // The cap bounds a bubble that never finishes a sentence. A finished sentence
  // closes the bubble whatever its length: an 8 s piece of a fast speaker is
  // 150–200 characters, and a cap applied first refused every fold and left the
  // cut with nothing to do.
  if (!follows || (cut < 0 && last.text.length + entry.text.length >= maxChars)) {
    transcript.push(entry);
    return [entry];
  }
  const before = last.text;
  if (cut < 0) {
    last.text = merged;
    last.dur = Math.round((entry.t + entry.dur * 1000 - last.t) / 100) / 10;
    return [last];
  }
  const head = merged.slice(0, cut).trim();
  const opened = {
    speaker: entry.speaker,
    text: merged.slice(cut).trim(),
    t: entry.t,
    dur: entry.dur,
    lang: entry.lang ?? last.lang,
  };
  if (opened.lang === undefined) delete opened.lang;
  transcript.push(opened);
  if (head === before) return [opened];
  last.text = head;
  // The cut fell inside a piece whose inner boundary is not known, so the
  // closed turn is stamped as ending where the new piece began.
  last.dur = Math.round((entry.t - last.t) / 100) / 10;
  return [last, opened];
}
