# Origin of copied files

These files are copies, not links, from the English Coach Chrome extension
(`/Users/octopus/Downloads/english-coach`), at commit `ded2c34`. A fix made here
or in the extension is ported by hand; the two do not share history.

| File | Source path | Commit |
|---|---|---|
| `lib/segmenter.js` | `segmenter.js` | `ded2c34` (modified, see note below) |
| `lib/segmenter.test.js` | `segmenter.test.js` | `ded2c34` (one test added, see note below) |
| `lib/stitch.js` | `stitch.js` | `ded2c34` |
| `lib/stitch.test.js` | `stitch.test.js` | `ded2c34` |
| `lib/queue.js` | `queue.js` | `ded2c34` |
| `lib/queue.test.js` | `queue.test.js` | `ded2c34` |
| `lib/langid.js` | `langid.js` | `ded2c34` |
| `lib/langid.test.js` | `langid.test.js` | `ded2c34` |
| `lib/live.js` | `live.js` | `ded2c34` (modified, see note below) |
| `lib/live.test.js` | `live.test.js` | `ded2c34` (two tests added) |
| `recorder-worklet.js` | `recorder-worklet.js` | `ded2c34` (modified, see note below) |
| `vendor/transformers.js` | `vendor/transformers.js` | `ded2c34` |
| `vendor/ort-wasm-simd-threaded.mjs` | `vendor/ort-wasm-simd-threaded.mjs` | `ded2c34` |
| `vendor/ort-wasm-simd-threaded.wasm` | `vendor/ort-wasm-simd-threaded.wasm` | `ded2c34` |
| `vendor/ort-wasm-simd-threaded.asyncify.mjs` | `vendor/ort-wasm-simd-threaded.asyncify.mjs` | `ded2c34` |
| `vendor/ort-wasm-simd-threaded.asyncify.wasm` | `vendor/ort-wasm-simd-threaded.asyncify.wasm` | `ded2c34` |
| `e2e/cdp.mjs` | `e2e/cdp.mjs` | `ded2c34` (modified, see note below) |
| `e2e/mock-groq.mjs` | `e2e/mock-groq.mjs` | `ded2c34` |
| `lib/coach.js` | `coach.js` | `ded2c34` (modified, see note below) |
| `lib/coach.test.js` | `coach.test.js` | `ded2c34` (adapted and extended, see note below) |
| `lib/phrasebook.js` | `phrasebook.js` | `ded2c34` |
| `lib/phrasebook.test.js` | `phrasebook.test.js` | `ded2c34` |
| `preview-worker.js` | `worker.js` | `ded2c34` (rewritten: its WebGPU load ladder only, see `live-lane.js` for the preview lane's rules from `offscreen.js`) |
| `LICENSE` | `LICENSE` | `ded2c34` |
| `THIRD-PARTY-NOTICES.md` | `THIRD-PARTY-NOTICES.md` | `ded2c34` |

## `lib/segmenter.js`: three changes, the extension's behaviour unchanged by default

Diffed against `ded2c34` on 2026-10-10:

- `voicedThreshold(floor)` and `pushFloor(state, rms)` are exported (Phase 1, the enrollment's voiced gate): the
  adaptive noise floor and the 2.5× / 0.008 voicing rule moved out of `push()` unchanged, so
  `enroll-audio.js` judges a block by the same rule. `push()` calls `pushFloor(this, rms)`.
- A `silenceMs` option (Phase 3, Task 1): `opts.silenceMs ?? SILENCE_MS` replaces the constant in
  the closing check. The default stays the extension's 700 ms; `capture.js` passes
  `MIXED_SILENCE_MS` (450 ms) because both voices share one track here, and `e2e/speakers.mjs`
  passes the same constant.
- `lib/segmenter.test.js` gained one test: «silenceMs closes a phrase on a shorter pause without
  changing the default».

Both changes are worth porting back only if the extension needs them; the option is inert there.

## `e2e/cdp.mjs`: no autoplay flag (Phase 1 review fixes, 2026-10-02)

`--autoplay-policy=no-user-gesture-required` is removed from Chrome's launch flags, so a meeting
whose AudioContext is not created inside a real tap fails in the harness as it would for a user.

## `lib/live.js`: results joined with a space (Phase 2, Task 7, fix round 1)

The extension concatenated the recogniser's results with nothing between them, so
a final followed by the next interim read "numbersI think" (seen in the harness's
speech log). `joined()` now trims each result and joins the non-empty ones with a
single space, and `reset()` counts the characters it skips in that same joined
text, so the mid-word cut correction does not drift by one per result. Two tests
in `lib/live.test.js` cover both. Worth porting back to the extension.

## `recorder-worklet.js`: diverged from the copy (Task 5, fix round 1)

The extension assumes its AudioContext is always 16 kHz, because the extension
builds that context inside an offscreen document it fully controls. This PWA's
`capture.js` creates its AudioContext at the device's native rate (no
`sampleRate` option): Firefox refuses to connect a `MediaStreamSource` to a
context whose rate differs from the device's, and Safari's handling of a
non-native rate fed by the microphone is untested. `capture.js` passes the
context's actual `sampleRate` to the worklet as `processorOptions.inputRate`,
and this file linearly resamples to 16 kHz itself whenever that differs, before
emitting its usual 1600-sample (100 ms) blocks — the Segmenter and every other
module in this repo still only ever sees 16 kHz audio. The resampling math
(`resampleChunk`) is a pure, exported function with its own test
(`recorder-worklet.test.js`); the `AudioWorkletProcessor` class around it is
guarded so importing the file for that pure function stays possible under
`node --test` (the same reason `embed.js` imports `vendor/transformers.js`
lazily). Everything else in the file — the 100 ms block size, the RMS
calculation, the message shape posted to the main thread — is unchanged from
the extension's copy.

## `e2e/mock-groq.mjs`: diverged from the copy (Task 7)

The conversation manifests' cues carry no `key`, so a cue's index stands in for it. The extension's
stand-in places a request by its arrival time minus a fixed 0.7 s closing silence. Measured against
the app (the arrival-time guess against where the audio actually sits on the fixture), that picks a
different cue for 5 to 13 of 17 to 18 requests per run: with step 5b a segment waits for the
embeddings of its windows, which grows with the segment, and a forced cut carries no closing silence
at all. The copy now takes the fixture's WAV (`wav`), slides the received audio's loudness envelope
along the fixture's to find where it came from (normalised correlation, 50 ms frames), and answers
with the share of each overlapped cue's words (at least one word from 0.3 s of overlap), in order, so a
segment straddling a handoff is transcribed the way a real recogniser would, minority words included. Arrival time stays as the fallback when no
fixture is given or the best correlation is under 0.5, and each logged request keeps the
arrival-time cue as `arrivalCue` for comparison.

## `app.js`: the loopback hook

`window.__ec.events` (only on 127.0.0.1) now stores a copy of each event's entry, since the session
keeps mutating the entry as later pieces fold into it and the harness needs every intermediate text.

## `lib/coach.js`: diverged from the copy (Phase 2, Task 4)

The coach's own network layer is gone: `PROVIDERS`, `resolveProvider`, `callGroq`, `callAnthropic`,
`groqBaseOf`, `anthropicBaseOf`, `redact`/`KEY_SHAPED` and the old `ask` provider switch. `ask` now
calls `callChat` from `providers.js` (provider, key, model, retries, timeout, redaction and staged
errors all come from there) and reads `settings.chatProvider` / `settings.keys` / `settings.models`.
Kept as copied: every prompt, `parseReply`, `parseJsonLoose`, `runsOf`, `turnsToText`, the limits
(`JSON_BUDGET`, `REPORT_MAX_CHARS`, `TURN_MAX_CHARS`, profile/context caps) and the thinking floor
(now keyed by `chatProvider`). Differences worth knowing:

- `DEFAULT_COACH` lost `reportProvider`, `reportModel`, `liveCoach`, `autoReport`: the provider is the
  learner's single chat choice, and the reply and the report use the same one.
- The JSON schema reaches `callChat` only where output can be constrained: Groq with a `openai/gpt-oss*`
  model (the extension's rule), OpenAI, Gemini, Claude. Other Groq models and the local server get no
  schema; `parseJsonLoose` recovers the JSON. The extension's `strict: true` and `temperature: 0.3`
  are not sent (`buildChat` sends neither).
- `askReply` takes an optional `documents` (the records of «Mis documentos»); `documentsQuery`/`documentsBlock`
  add the best passages (BM25, `lib/passages.js`) up to `DOCUMENTS_MAX_CHARS` = 8000 (3000 until 2026-10-12) after the profile and the
  context, and nothing when none is enabled or none scores. `askReport` does not use them (Phase 3, Task 4). Document text is neutralised (`neutralise`): any line
  naming the block's delimiters loses its dashes, and the header says the content is data, never instructions.
  Phase 3 rules, all PWA-only (the extension has no documents): enabled passages totalling ≤ 8000
  characters are sent whole with no search; otherwise the best BM25 matches, whole, until the cap; when
  nothing scores, the first passage of each enabled document. `neutralise` runs on the picked passages
  only, after selection. The BM25 index is kept in a one-entry memo keyed by the enabled documents'
  `id:passageCount` list (records are never edited in place, so adding, toggling or deleting one changes
  the key; a document without an id is never cached): at 10 × 200 000 characters a cold «Respuesta»
  spent 121–137 ms (median, two runs) building it and a warm one 2.1–2.5 ms searching (`node e2e/docs-reply.mjs --max`).
- `CoachError` messages carry the `[coach]` stage prefix.
- `askReply`/`askReport` take two optional extras: `signal` and `chat` (defaults to `callChat`; the tests
  inject a stub).
- The extension's "fall back to whichever provider has a key" is dropped: a missing key for the chosen
  provider is `[coach] Falta la API key de <proveedor>.`

## `lib/coach.test.js`: adapted tests

Unchanged apart from the settings shape (`reportProvider`/`reportModel`/`groqKey`/`anthropicKey` became
`chatProvider` + `keys.<id>`, in the `REPLY_SETTINGS` and `CLAUDE_SETTINGS` constants), because those
tests went through the removed Groq/Anthropic code. Their assertions are untouched; the `fetch` stubs still
work because `callChat` builds the same bodies. Adapted tests (12): the Claude report is given room to
think; Groq keeps its measured ceiling (also drops the now-redundant `reportProvider: 'groq'` override);
never send a sampling parameter to Claude; askReply clips a repetition-loop turn; askReply's system
prompt names / does not name the 'multi' rule (2); askReply labels turns with their language;
askReport's system prompt names / does not name the 'multi' rule (2); askReport labels turns with their
language; askReport marks the transcript partial when a turn is clipped; askReport reports a complete
transcript when same-speaker turns merge. Added (7): the `callChat` request of `askReply` and
`askReport` (system, user, schema, ceiling, stage), schema withheld per provider, thinking ceiling, an
OpenAI request through the real layer, the missing-key error, and the no-learner-turns refusal.
Added in Phase 3 (Task 4 and the final fix wave): the documents block — passages after profile and
context, disabled documents never sent, no documents leaves the prompt byte-for-byte, short documents
sent whole, the opening passages when nothing scores, the cap, `documentsQuery`, delimiter
neutralisation (whole and searched), and the cached index following add/toggle/delete.
`lib/phrasebook.js` and `lib/phrasebook.test.js` are verbatim.

## `vendor/pdfjs/`: PDF.js from npm (Phase 3, Task 2)

Not from the extension: copied verbatim from the npm tarball of `pdfjs-dist@6.4.299`
(`https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz`). The tarball's sha512 matched
the registry's `dist.integrity`,
`sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`
(`shasum` `4a46f5146ac6505564c1a5d472900be4df8bf628`), checked on 2026-10-10 before anything was copied.

| File | Package path | sha256 |
|---|---|---|
| `vendor/pdfjs/pdf.min.mjs` | `build/pdf.min.mjs` | `57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2` |
| `vendor/pdfjs/pdf.worker.min.mjs` | `build/pdf.worker.min.mjs` | `9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18` |
| `vendor/pdfjs/LICENSE` | `LICENSE` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |

Nothing else from the package is copied: no source maps, no `cmaps/`, `standard_fonts/`, `wasm/`
or `iccs/` (text extraction does not need them), no viewer. Replace the three files together
from a newer tarball, re-check its integrity, and update this table.

## `lib/coach.js`: the reply prompt (2026-10-12)

PWA-only, after a real meeting where «Respuesta» was curt and claimed a prototype the learner
did not have. `REPLY_SYSTEM`'s "answer" asks for 2–4 plain B2 sentences (30–60 words, full forms
over contractions, common words, the direct answer first and one or two specific details), answers
the most recent turn even when it is a clarification, and forbids presenting anything as done or
measured, or guessing any number, unless the background or the learner's own turns state it.
`DEFAULT_COACH.level` is `B2` (was `B1-B2`). `JSON_BUDGET` is 2000 (was 1200), and Groq's gpt-oss
models get `reasoning_effort: 'low'` (`providers.js`): measured on real Groq over 12 calls,
0 truncations and 0.9–2.2 s (one 11 s, a rate-limit wait), against 4 truncated of 9 at 1200 with
the default effort and 2.4–19 s at `medium`.
