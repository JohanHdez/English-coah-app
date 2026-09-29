import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Segmenter, isJunk, floatToWav, foldIntoTranscript, sentenceCut,
  CHUNK_MS, SILENCE_MS, MAX_SEG_MS, SOFT_CUT_MS, SOFT_SILENCE_MS, MIN_VOICED, PREROLL,
  MERGE_GAP_MS, MERGE_MAX_CHARS, PREVIEW_EVERY_MS, PREVIEW_MIN_MS, SR,
} from './segmenter.js';

const VOICE = 0.5;
const QUIET = 0.001;
const block = (amp) => ({ samples: new Float32Array(1600).fill(amp), rms: amp });

// Runs a [amplitude, blocks] pattern through a Segmenter, with ambient noise
// first so the adaptive floor settles the way it does in a real capture.
function run(pattern) {
  const out = [];
  let t = 0;
  const seg = new Segmenter('them', (s) => out.push(s), () => t);
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  for (const [amp, n] of pattern) {
    for (let i = 0; i < n; i++) { t += CHUNK_MS; seg.push(block(amp)); }
  }
  seg.flush();
  return out;
}

test('a monologue with only breath dips streams out as short pieces', () => {
  const pattern = [];
  for (let i = 0; i < 6; i++) pattern.push([VOICE, 45], [QUIET, SOFT_SILENCE_MS / CHUNK_MS]);
  const segs = run(pattern);
  assert.ok(segs.length >= 5, `expected a stream of pieces, got ${segs.length}`);
  for (const s of segs) {
    assert.ok(s.durationMs < MAX_SEG_MS, 'no piece should need the hard cut');
    assert.ok(s.durationMs >= SOFT_CUT_MS, `piece of ${s.durationMs}ms is below the soft-cut floor`);
  }
});

test('pieces of a monologue keep ascending timestamps', () => {
  const pattern = [];
  for (let i = 0; i < 4; i++) pattern.push([VOICE, 45], [QUIET, 3]);
  const segs = run(pattern);
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i].startedAt > segs[i - 1].startedAt, 'chunks must sort correctly against the other speaker');
  }
});

test('a normal short phrase with a real pause stays one segment', () => {
  const segs = run([[VOICE, 20], [QUIET, SILENCE_MS / CHUNK_MS + 1]]);
  assert.equal(segs.length, 1);
});

test('a breath dip before SOFT_CUT_MS does not cut', () => {
  const segs = run([[VOICE, 10], [QUIET, 3], [VOICE, 10], [QUIET, 8]]);
  assert.equal(segs.length, 1, 'the dip at 1s must be swallowed into the phrase');
});

test('speech with no dips at all still hits the hard cut', () => {
  const segs = run([[VOICE, 90], [QUIET, 8]]);
  assert.equal(segs[0].durationMs, MAX_SEG_MS);
  assert.equal(segs.length, 2);
});

test('the noise floor stays frozen across soft cuts of one monologue', () => {
  // Breath dips carry more energy than true ambient. If a soft cut returned the
  // segmenter to idle, the floor would adapt toward the dips and ratchet the
  // threshold up until quiet word onsets stopped crossing it.
  const AMBIENT = 0.004;
  // Above ambient, below the activation threshold (max(floor*2.5, 0.008)): a dip
  // louder than that reads as speech and rightly never cuts anything.
  const DIP = 0.0079;
  const out = [];
  let t = 0;
  const seg = new Segmenter('them', (s) => out.push(s), () => t);
  for (let i = 0; i < 20; i++) { t += CHUNK_MS; seg.push(block(AMBIENT)); }
  const round = () => {
    for (let i = 0; i < 40; i++) { t += CHUNK_MS; seg.push(block(VOICE)); }
    for (let i = 0; i < 4; i++) { t += CHUNK_MS; seg.push(block(DIP)); }
  };
  // The floor legitimately absorbs one block at utterance start (pre-existing,
  // once per utterance). The invariant under test is that it does not keep
  // ratcheting across the soft cuts inside the monologue.
  round();
  const afterFirstCut = seg.floor;
  for (let r = 0; r < 11; r++) round();
  assert.equal(seg.floor, afterFirstCut,
    `floor ratcheted from ${afterFirstCut.toFixed(5)} to ${seg.floor.toFixed(5)} across soft cuts`);
  assert.ok(out.length >= 10, `monologue should keep streaming pieces, got ${out.length}`);
});

test('a soft-cut dip that becomes a real pause leaves no phantom segment', () => {
  // The stub accumulated after a mid-utterance cut, if the dip just continues
  // into a real pause, must be discarded by the minimum-length rules.
  const segs = run([[VOICE, 40], [QUIET, 12]]);
  assert.equal(segs.length, 1);
  assert.ok(segs[0].durationMs >= SOFT_CUT_MS);
});

test('short noises are still discarded', () => {
  const segs = run([[VOICE, MIN_VOICED - 2], [QUIET, 8]]);
  assert.equal(segs.length, 0);
});

test('the words after a forced cut are emitted, however few', () => {
  // Enough voice for exactly one forced cut, then MIN_VOICED - 1 more blocks of
  // speech before a real pause: the tail is short, but it is the end of a phrase
  // the segmenter itself cut, not a stray sound.
  const blocks = MAX_SEG_MS / CHUNK_MS - PREROLL + (MIN_VOICED - 1);
  const segs = run([[VOICE, blocks], [QUIET, 12]]);
  assert.equal(segs.length, 2, `expected the cut piece and its tail, got ${segs.length}`);
  assert.equal(segs[0].open, true);
  assert.equal(segs[1].open, false);
  assert.ok(segs[1].durationMs > 0);
});

test('a lone blip between phrases is still discarded', () => {
  const segs = run([[VOICE, MIN_VOICED - 1], [QUIET, 12]]);
  assert.equal(segs.length, 0);
});

test('flush leaves no state behind for the next phrase', () => {
  const out = [];
  let t = 0;
  const seg = new Segmenter('them', (s) => out.push(s), () => t);
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  for (let i = 0; i < 20; i++) { t += CHUNK_MS; seg.push(block(VOICE)); }
  seg.flush();
  const firstLen = out[0].audio.length;
  for (let i = 0; i < 20; i++) { t += CHUNK_MS; seg.push(block(VOICE)); }
  seg.flush();
  assert.equal(out.length, 2);
  assert.ok(out[1].audio.length <= firstLen + 3 * 1600, 'second phrase must not inherit the first one\'s chunks');
});

test('isJunk drops lone hesitations and keeps real short answers', () => {
  for (const junk of ['Hmm.', 'Ooh.', 'uh', 'Uh-huh', 'er', '']) assert.ok(isJunk(junk), junk);
  for (const real of ['Okay.', 'No.', 'Yeah, sure.', 'I do.']) assert.ok(!isJunk(real), real);
});

test('floatToWav produces a valid 16 kHz mono PCM16 header', async () => {
  const wav = floatToWav(new Float32Array(1600).fill(0.5));
  const view = new DataView(await wav.arrayBuffer());
  assert.equal(view.getUint32(24, true), 16000);       // sample rate
  assert.equal(view.getUint16(22, true), 1);           // mono
  assert.equal(view.getUint32(40, true), 1600 * 2);    // data length
});

test('same-speaker entries within the merge gap fold into one turn', () => {
  const tr = [{ speaker: 'me', text: 'I think I need more', t: 1000, dur: 2 }];
  const shown = foldIntoTranscript(tr, { speaker: 'me', text: 'fluency in English.', t: 4500, dur: 1.5 });
  assert.equal(tr.length, 1);
  assert.equal(tr[0].text, 'I think I need more fluency in English.');
  assert.deepEqual(shown, [tr[0]]);
  assert.equal(tr[0].dur, 5);
});

test('a different speaker or a long silence starts a new turn', () => {
  const tr = [{ speaker: 'me', text: 'Hello.', t: 0, dur: 1 }];
  foldIntoTranscript(tr, { speaker: 'them', text: 'Hi.', t: 1500, dur: 1 });
  assert.equal(tr.length, 2);
  foldIntoTranscript(tr, { speaker: 'them', text: 'A later thought.', t: 2500 + MERGE_GAP_MS + 1000, dur: 1 });
  assert.equal(tr.length, 3);
});

test('a merged turn stops growing at the character cap', () => {
  const tr = [{ speaker: 'them', text: 'x'.repeat(MERGE_MAX_CHARS), t: 0, dur: 5 }];
  foldIntoTranscript(tr, { speaker: 'them', text: 'more', t: 5500, dur: 1 });
  assert.equal(tr.length, 2);
});

test('the cap does not stop a cut at a finished sentence', () => {
  const tr = [{ speaker: 'them', text: 'a'.repeat(390), t: 1000, dur: 8, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'and ends here. Next idea', t: 9000, dur: 8, lang: 'en' });
  assert.equal(tr.length, 2);
  assert.equal(tr[0].text, 'a'.repeat(390) + ' and ends here.');
  assert.equal(tr[1].text, 'Next idea');
  assert.deepEqual(shown, [tr[0], tr[1]]);
});

test('consecutive turns in different languages do not fold', () => {
  // The tab track carries every remote participant, so English and Spanish
  // alternate on one speaker. Folded, they would share a bubble and a single
  // translation.
  const tr = [{ speaker: 'them', text: 'We can ship on Friday.', t: 1000, dur: 2, lang: 'en' }];
  foldIntoTranscript(tr, { speaker: 'them', text: 'Perdón, ¿el viernes?', t: 4000, dur: 1.5, lang: 'es' });
  assert.equal(tr.length, 2);
});

test('consecutive turns in the same language still fold', () => {
  const tr = [{ speaker: 'them', text: 'We can ship', t: 1000, dur: 2, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'on Friday.', t: 4000, dur: 1, lang: 'en' });
  assert.equal(tr.length, 1);
  assert.equal(tr[0].text, 'We can ship on Friday.');
  assert.deepEqual(shown, [tr[0]]);
});

test('a transcript written before languages existed folds exactly as it did', () => {
  // Entries stored by an earlier version carry no lang at all.
  const tr = [{ speaker: 'me', text: 'I think I need more', t: 1000, dur: 2 }];
  foldIntoTranscript(tr, { speaker: 'me', text: 'fluency in English.', t: 4500, dur: 1.5 });
  assert.equal(tr.length, 1);
  // And a labelled entry folds into an unlabelled one rather than splitting the turn.
  const mixto = [{ speaker: 'me', text: 'I think', t: 1000, dur: 2 }];
  foldIntoTranscript(mixto, { speaker: 'me', text: 'so too.', t: 4000, dur: 1, lang: 'en' });
  assert.equal(mixto.length, 1);
});

test('folding compares against the chronologically latest turn, not the last appended', () => {
  // The transcription queue lets 'them' overtake 'me', so an older 'me' segment
  // can be appended after a newer 'them' one.
  const tr = [
    { speaker: 'them', text: 'Question?', t: 10000, dur: 2 },
    { speaker: 'me', text: 'Earlier words', t: 5000, dur: 1 },
  ];
  foldIntoTranscript(tr, { speaker: 'me', text: 'arriving late', t: 6500, dur: 1 });
  assert.equal(tr.length, 3);
});

// A cut with the speaker still going (soft or hard) is not the end of the phrase:
// the consumer needs to know the difference, because blanking the live line on a
// mid-speech cut erases text from under someone who is still talking.
test('mid-speech cuts are open, a real pause closes', () => {
  const pattern = [];
  for (let i = 0; i < 3; i++) pattern.push([VOICE, 45], [QUIET, 3]);
  const stream = run(pattern);
  assert.ok(stream.length >= 2, `expected a stream of pieces, got ${stream.length}`);
  for (const s of stream) assert.equal(s.open, true, 'a soft cut leaves the phrase open');
  const closed = run([[VOICE, 20], [QUIET, SILENCE_MS / CHUNK_MS + 1]]);
  assert.equal(closed[0].open, false, 'the piece closed by silence ends the phrase');
});

test('the hard cut also leaves the phrase open', () => {
  const segs = run([[VOICE, 90], [QUIET, 8]]);
  assert.equal(segs[0].durationMs, MAX_SEG_MS);
  assert.equal(segs[0].open, true);
});

test('an explicit flush closes the phrase', () => {
  const out = [];
  let t = 0;
  const seg = new Segmenter('me', (s) => out.push(s), () => t);
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  for (let i = 0; i < 20; i++) { t += CHUNK_MS; seg.push(block(VOICE)); }
  seg.flush();
  assert.equal(out[0].open, false, 'pause and stop flush mid-phrase, and that ends it');
});

// ------------------------------------------------------------------ previews

// Like run(), but keeps the phrase open: the preview lane is about what the
// segmenter emits *before* anything closes.
function runWithPreview(pattern, opts = {}) {
  const segs = [];
  const previews = [];
  let t = 0;
  const seg = new Segmenter('them', (s) => segs.push(s), () => t, {
    onPreview: (p) => previews.push(p),
    ...opts,
  });
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  for (const [amp, n] of pattern) {
    for (let i = 0; i < n; i++) { t += CHUNK_MS; seg.push(block(amp)); }
  }
  return { seg, segs, previews };
}

test('an open phrase previews itself while it is still growing', () => {
  const { segs, previews } = runWithPreview([[VOICE, 40]]);
  assert.equal(segs.length, 0, 'nothing has closed the phrase yet');
  // The rule, not the constants: the first preview is due as soon as both floors
  // are met — which is when the MIN_VOICED-th voiced block lands, in a buffer that
  // also holds the lead-in — and the rest follow one interval apart.
  const at = previews.map((p) => p.durationMs);
  assert.equal(at[0], (MIN_VOICED + PREROLL - 1) * CHUNK_MS);
  for (let i = 1; i < at.length; i++) assert.equal(at[i] - at[i - 1], PREVIEW_EVERY_MS);
});

test('a preview carries the audio captured so far, tagged with its speaker', () => {
  const { previews } = runWithPreview([[VOICE, 40]]);
  assert.ok(previews.length > 0, 'the phrase must have been previewed at all');
  for (const p of previews) {
    assert.equal(p.speaker, 'them');
    assert.equal(p.audio.length, (p.durationMs / CHUNK_MS) * 1600);
  }
});

// Which floor actually gates the first preview of a piece — measured, because the
// answer is not the constant it looks like. Lowering PREVIEW_MIN_MS on its own
// moves nothing: MIN_VOICED voiced blocks have to accumulate first, and the buffer
// they arrive in already carries PREROLL-1 blocks of lead-in on top of them, so the
// duration floor is satisfied by the same block that satisfies the voiced floor.
// Anyone trying to cut the wait has to move MIN_VOICED, and this test says so.
function firstPreviewOf(previewMinMs) {
  const previews = [];
  let t = 0;
  let onset = null;
  const seg = new Segmenter('them', () => {}, () => t, {
    onPreview: (p) => previews.push({ at: t, durationMs: p.durationMs }),
    previewMinMs,
  });
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  for (let i = 0; i < 20; i++) {
    t += CHUNK_MS;
    seg.push(block(VOICE));
    if (onset === null) onset = t;
  }
  return { sinceOnset: previews[0].at - onset, buffer: previews[0].durationMs };
}

test('the voiced-block floor gates the first preview, not PREVIEW_MIN_MS', () => {
  const base = firstPreviewOf(PREVIEW_MIN_MS);
  // The onset block is itself the first voiced one, so the wait is the remaining
  // MIN_VOICED-1 blocks — 400ms, not the 700ms the buffer length suggests.
  assert.equal(base.sinceOnset, (MIN_VOICED - 1) * CHUNK_MS);
  assert.equal(base.buffer, (MIN_VOICED + PREROLL - 1) * CHUNK_MS);
  for (const lower of [400, 300, 200]) {
    assert.deepEqual(firstPreviewOf(lower), base,
      `previewMinMs=${lower} moved the first preview; MIN_VOICED is supposed to bind`);
  }
});

test('PREVIEW_MIN_MS still gates once it is above the voiced-block floor', () => {
  // Injected above the floor: on the defaults the two coincide, so a test using
  // them could not say which rule refused.
  const opts = { previewMinMs: 900 };
  assert.equal(runWithPreview([[VOICE, 6]], opts).previews.length, 0,
    'past MIN_VOICED but under the duration floor');
  const late = runWithPreview([[VOICE, 12]], opts).previews;
  assert.ok(late.length > 0, 'the same speech, past the floor, previews');
  assert.equal(late[0].durationMs, 900);
});

test('speech shorter than PREVIEW_MIN_MS is never previewed', () => {
  const short = PREVIEW_MIN_MS / CHUNK_MS - 4;
  assert.equal(runWithPreview([[VOICE, short], [QUIET, 8]]).previews.length, 0);
  // Positive control: the same shape, long enough, does preview.
  assert.ok(runWithPreview([[VOICE, short + 8], [QUIET, 8]]).previews.length > 0);
});

test('silence alone is never previewed', () => {
  const { previews } = runWithPreview([[QUIET, 60]]);
  assert.equal(previews.length, 0);
});

test('previews are spaced by PREVIEW_EVERY_MS', () => {
  // Short enough to stay under MAX_SEG_MS: a forced cut mid-run would reset the
  // phrase and break the uniform spacing this test checks.
  const { previews } = runWithPreview([[VOICE, 60]]);
  assert.ok(previews.length >= 3, `expected several previews, got ${previews.length}`);
  for (let i = 1; i < previews.length; i++) {
    assert.equal(previews[i].durationMs - previews[i - 1].durationMs, PREVIEW_EVERY_MS);
  }
});

test('a preview never steals audio from the real segment', () => {
  const { seg, segs, previews } = runWithPreview([[VOICE, 40]]);
  seg.flush();
  assert.ok(previews.length > 0, 'the phrase must have been previewed at all');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].audio.length, 42 * 1600, 'the closed segment keeps every chunk');
});

test('the push that cuts the phrase emits the segment, not another preview', () => {
  // The authoritative text lands on that same push; a provisional copy of the
  // very same audio would only flicker on screen before being replaced.
  const { segs, previews } = runWithPreview([[VOICE, 40], [QUIET, 3]], { previewEveryMs: CHUNK_MS });
  assert.equal(segs.length, 1);
  assert.ok(previews.length > 0, 'with no throttle every push before the cut previews');
  assert.ok(!previews.some((p) => p.durationMs === segs[0].durationMs),
    'a preview duplicated the audio of the segment that just closed');
});

test('each piece of a monologue previews on its own', () => {
  const pattern = [];
  for (let i = 0; i < 3; i++) pattern.push([VOICE, 45], [QUIET, 3]);
  const { segs, previews } = runWithPreview(pattern);
  assert.ok(segs.length >= 2, `expected a stream of pieces, got ${segs.length}`);
  assert.ok(previews.some((p, i) => i > 0 && p.durationMs < previews[i - 1].durationMs),
    'the preview clock must restart at each soft cut instead of growing across pieces');
});

test('without an onPreview callback the segmenter behaves exactly as before', () => {
  const withOut = run([[VOICE, 40], [QUIET, 12]]);
  assert.equal(withOut.length, 1);
});

test('a preview never carries more than the tail window, however long the phrase', () => {
  const previews = [];
  let t = 0;
  // A window shorter than MAX_SEG_MS: at the default they now coincide, and the
  // forced cut would retire each piece right as it reached the window, so the cap
  // under test would never actually be exercised.
  const previewTailMs = 3000;
  const seg = new Segmenter('them', () => {}, () => t, { onPreview: (p) => previews.push(p), previewTailMs });
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  // 30 s of unbroken speech — a synthetic voice with no breath dips, which is the
  // case that used to make every pass slower than the last until the lane retired.
  // It now spans several forced cuts of the new, shorter MAX_SEG_MS; the cap must
  // hold within each piece.
  for (let i = 0; i < 300; i++) { t += CHUNK_MS; seg.push(block(VOICE)); }

  assert.ok(previews.some((p) => p.durationMs > previewTailMs), 'the phrase must outgrow the window');
  const cap = (previewTailMs / 1000) * SR;
  for (const p of previews) {
    assert.ok(p.audio.length <= cap + 1600, `${p.audio.length} samples is past the ${cap} window`);
  }
});

test('a preview carries the end of the phrase, not its beginning', () => {
  const previews = [];
  let t = 0;
  const seg = new Segmenter('them', () => {}, () => t, {
    onPreview: (p) => previews.push(p),
    previewTailMs: 1000,
  });
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  // Each block is stamped with its own position, so the samples say where in the
  // phrase they came from.
  for (let i = 0; i < 60; i++) {
    t += CHUNK_MS;
    seg.push({ samples: new Float32Array(1600).fill(0.4 + i / 1000), rms: VOICE });
  }

  const last = previews[previews.length - 1];
  assert.equal(last.audio.length, (1000 / CHUNK_MS) * 1600);
  const head = new Float32Array([0.4])[0];
  assert.notEqual(last.audio[0], head, 'the preview kept the head of the phrase instead of the tail');
});

// A preview the engine cannot take must not spend the phrase's slot: refusing used
// to cost a full PREVIEW_EVERY_MS of blank line, and another for each refusal after
// it. That is the stutter the learner sees just after every bubble — the engine is
// busy transcribing the segment that produced it, and frees a moment later.
test('a refused preview does not spend the slot and is re-offered at once', () => {
  const previews = [];
  let busy = true;
  let t = 0;
  const seg = new Segmenter('them', () => {}, () => t, {
    onPreview: (p) => previews.push(p),
    canPreview: () => !busy,
  });
  for (let i = 0; i < 10; i++) { t += CHUNK_MS; seg.push(block(QUIET)); }
  // Past the point where the first preview was due, and refused there.
  for (let i = 0; i < 12; i++) { t += CHUNK_MS; seg.push(block(VOICE)); }
  assert.equal(previews.length, 0, 'a refused preview must not be delivered');

  // The engine frees well inside PREVIEW_EVERY_MS of that refusal.
  busy = false;
  t += CHUNK_MS;
  seg.push(block(VOICE));
  assert.equal(previews.length, 1, 'the lane waited instead of resuming on the first free block');
});

test('a speaker who never dips streams out in pieces of at most eight seconds', () => {
  const segs = run([[VOICE, 200]]);   // 20 s without a single breath dip
  assert.ok(segs.length >= 3, `expected forced cuts every eight seconds, got ${segs.length} pieces`);
  for (const s of segs) assert.ok(s.durationMs <= 8000, `a piece lasted ${s.durationMs} ms`);
  for (const s of segs.slice(0, -1)) assert.ok(s.open, 'a forced cut is an open cut');
});

test('sentenceCut finds the tail after the last sentence end', () => {
  assert.equal(sentenceCut('Fine. Go ahead'), 6);
  assert.equal(sentenceCut('Really? Yes. Go ahead'), 13);
  assert.equal(sentenceCut('He said "done." Then left'), 16);
  assert.equal(sentenceCut('He said \u201Cdone.\u201D Then left'), 16);
  assert.equal(sentenceCut('Claro. ¿Y el viernes?'), 7);
  assert.equal(sentenceCut('Wait… Okay'), 6);
});

test('sentenceCut ignores decimals, lowercase continuations and a trailing full stop', () => {
  assert.equal(sentenceCut('it costs 1.5 million'), -1);
  assert.equal(sentenceCut('fine. go ahead'), -1);
  assert.equal(sentenceCut('That is the whole project.'), -1);
  assert.equal(sentenceCut(''), -1);
});

test('a fold with a sentence end inside the new piece closes the bubble there and opens a new one', () => {
  const tr = [{ speaker: 'them', text: 'and I love that you are treating me like a crash test dummy', t: 1000, dur: 8, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'for your project. Go ahead and put that engine', t: 9000, dur: 8, lang: 'en' });
  assert.equal(tr.length, 2);
  assert.equal(tr[0].text, 'and I love that you are treating me like a crash test dummy for your project.');
  assert.equal(tr[0].t, 1000);
  assert.equal(tr[0].dur, 8);
  assert.equal(tr[1].text, 'Go ahead and put that engine');
  assert.equal(tr[1].t, 9000);
  assert.equal(tr[1].dur, 8);
  assert.equal(tr[1].lang, 'en');
  assert.equal(tr[1].speaker, 'them');
  assert.deepEqual(shown, [tr[0], tr[1]]);
});

test('a bubble that already ended at a sentence end is left alone and the piece opens a new one', () => {
  const tr = [{ speaker: 'them', text: 'We can ship on Friday.', t: 1000, dur: 3, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'Let me check the calendar', t: 4500, dur: 2, lang: 'en' });
  assert.equal(tr.length, 2);
  assert.equal(tr[0].text, 'We can ship on Friday.');
  assert.equal(tr[1].text, 'Let me check the calendar');
  assert.equal(tr[1].t, 4500);
  assert.deepEqual(shown, [tr[1]], 'unchanged text is not re-sent');
});

test('a sentence end inside the older text also cuts on the next fold', () => {
  // The first piece of a monologue arrives as a new turn and is not cut; the
  // cut happens when the next piece folds into it.
  const tr = [{ speaker: 'them', text: 'It makes me feel great. Go ahead and', t: 1000, dur: 8, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'put that engine to work', t: 9000, dur: 8, lang: 'en' });
  assert.equal(tr.length, 2);
  assert.equal(tr[0].text, 'It makes me feel great.');
  assert.equal(tr[1].text, 'Go ahead and put that engine to work');
  assert.equal(tr[1].t, 9000);
  assert.deepEqual(shown, [tr[0], tr[1]]);
});

test('a fold with no sentence end keeps growing one bubble', () => {
  const tr = [{ speaker: 'them', text: 'and then we moved the whole platform', t: 1000, dur: 8, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'over to the new framework while keeping', t: 9000, dur: 8, lang: 'en' });
  assert.equal(tr.length, 1);
  assert.equal(tr[0].text, 'and then we moved the whole platform over to the new framework while keeping');
  assert.deepEqual(shown, [tr[0]]);
});

test('the opened bubble folds the next piece, the closed one never does', () => {
  const tr = [{ speaker: 'them', text: 'First idea', t: 1000, dur: 8, lang: 'en' }];
  foldIntoTranscript(tr, { speaker: 'them', text: 'ends here. Second idea', t: 9000, dur: 8, lang: 'en' });
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'keeps going', t: 17000, dur: 8, lang: 'en' });
  assert.equal(tr.length, 2);
  assert.equal(tr[0].text, 'First idea ends here.');
  assert.equal(tr[1].text, 'Second idea keeps going');
  assert.deepEqual(shown, [tr[1]]);
});

test('an entry pushed as a new turn is returned as the only painted entry', () => {
  const tr = [];
  const entry = { speaker: 'me', text: 'Hello. How are you', t: 0, dur: 2 };
  assert.deepEqual(foldIntoTranscript(tr, entry), [entry]);
  assert.equal(tr[0].text, 'Hello. How are you', 'a turn that never folds is not cut');
});
