# English Coach (PWA)

A web app for phone and desktop that sits on the table during a meeting, listens through one
microphone, tells the learner's voice («Yo») from everyone else's («Interlocutor») by voice
print, and shows the conversation transcribed and translated live, with tap-to-correct and a
manual "I'm speaking" mode. It reuses the pure modules of the English Coach Chrome extension
(`/Users/octopus/Downloads/english-coach`) by copy, not by link — see `docs/ORIGIN.md`.

Full spec: `docs/2026-09-29-plan.md` (Spanish). Phase 1 plan: `docs/2026-09-29-phase1-plan.md`.

## Constraints

**No build step. No package.json. No dependencies. No bundler.** Every file that ships is a
file that was written by hand. Node (22+) is for tooling and tests only; the app itself never
runs in Node except through the pure modules under `node --test`. Chrome and Safari load the
files as-is over HTTPS (or `localhost`, a secure context) — nothing here is compiled.

- **Never modify anything under `/Users/octopus/Downloads/english-coach`** (the extension).
  Read it, and copy from a named commit with
  `git -C /Users/octopus/Downloads/english-coach show <commit>:<path> > <dst>`.
- `vendor/` holds copied third-party code (transformers.js + ONNX Runtime Web); never edit it,
  replace it wholesale from upstream instead.
- Pure logic stays pure: `lib/*.js` and (from Task 2) `speaker.js`, `session.js` import nothing
  from the DOM or `chrome`/browser-only APIs and take side effects as injected parameters, so
  they run unmodified under `node --test`. Keep new logic on that side of the line.
- The repository is English: identifiers, comments, documentation, commit messages. The
  **product** is Spanish: every UI string and user-visible error is Spanish. Never "fix" a
  Spanish UI string into English.
- Comments only for what the code cannot say — a browser-imposed behaviour, a measured number,
  a reason a later reader would otherwise have to rediscover. Never restate the code.
- Never pass dynamic content to `innerHTML`; use `textContent` and `createElement`.
- Secrets and biometrics: the Groq key and the voice print live in IndexedDB on the device and
  nowhere else. Never log them, never put the key in a URL or query string, never send the
  voice print anywhere — only the key goes to Groq's own host.
- The service worker (`sw.js`) never caches audio, POST requests, or cross-origin responses. It
  precaches the app shell, and keeps same-origin `vendor/` files cache-first in their own
  versioned cache (`ec-vendor-v1`, filled on first use — bump it when `vendor/` is replaced);
  model weights are cached by transformers.js itself.
- Audio starts only on a tap: `capture.js`'s `createAudioContext()` is called synchronously in
  the click handler («Empezar reunión», «Continuar», «Nueva reunión», «Reanudar», enrollment's
  «Empezar») and handed to `startCapture`. Browsers leave a context made without a gesture
  suspended. The harness taps with real mouse events (`tap()` in `e2e/harness.mjs`) and passes
  no autoplay flag (no harness needs one), so it cannot hide a regression here;
  `element.click()` from a script carries no user activation and ignores what covers the
  element — it hid a closed overlay that covered the whole app until 2026-10-02.
- User-visible errors are prefixed with the stage that produced them: `[micrófono]`, `[huella]`,
  `[groq]`, `[traducción]`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Implementers never dispatch subagents; review is the controller's job.

## File map

| Path | Responsibility | Task |
|---|---|---|
| `lib/segmenter.js` `lib/stitch.js` `lib/queue.js` `lib/langid.js` `lib/live.js` + tests | Copied from the extension, unchanged except import paths | 1 |
| `vendor/` | transformers.js + ONNX Runtime Web, copied | 1 |
| `recorder-worklet.js` | Copied: 100 ms blocks with RMS | 1 |
| `tools/serve.mjs` | Local static server (localhost is a secure context, so the mic works) | 1 |
| `tools/check.mjs` | The gate | 1 |
| `tools/icons.mjs` | Writes the PNG icons with `zlib` | 1 |
| `index.html` `app.css` `app.js` | Shell and screens | 1 (shell), 6 |
| `manifest.webmanifest` `sw.js` `icons/` | Installable app, offline shell | 1 |
| `speaker.js` + `speaker.test.js` | Who spoke: print, centres, decision, correction | 2 |
| `e2e/room.mjs` + `e2e/room.test.js` | Pure DSP: laptop-speaker and room simulation | 3 |
| `e2e/fixtures.mjs` | Synthesised enrollment and conversations with a ground-truth manifest | 3 |
| `embed.js` `embed-worker.js` | Speaker embeddings with WeSpeaker | 4 |
| `e2e/cdp.mjs` `e2e/speakers.mjs` `e2e/speakers.html` | Measures speaker accuracy and mixed segments | 4 |
| `session.js` + `session.test.js` | Segment → print → speaker → transcription → bubbles; pure orchestration with injected dependencies | 5 |
| `capture.js` `transcribe.js` | Microphone + worklet + Segmenter; Groq call | 5 |
| `store.js` `translate.js` `ui/*.js` | Device storage, translation, screens | 6 |
| `e2e/mock-groq.mjs` `e2e/run.mjs` `e2e/harness.mjs` `e2e/score.mjs` `e2e/smoke.mjs` | The whole app in Chrome with a fake mic and a Groq stand-in, scored per cue; a UI smoke test | 6, 7 |
| `README.md` `CLAUDE.md` `docs/ORIGIN.md` | Documentation | 1, 8 |

## Runtime contexts

Four contexts (fewer than the extension: no service-worker-as-router, no offscreen document, no
content script — this is an ordinary web app).

| Context | File(s) | Has | Lacks |
|---|---|---|---|
| Page | `app.js`, `ui/*.js` | DOM, `getUserMedia`, IndexedDB, fetch | nothing browser-standard |
| Dedicated worker | `embed-worker.js` | WASM/WebGPU, ONNX (via `vendor/`) | DOM |
| Audio worklet | `recorder-worklet.js` | realtime audio thread | everything else |
| Service worker | `sw.js` | install/activate/fetch, Cache API | DOM, direct page state |

There is no background/offscreen split: the page itself owns the session (capture, embedding
dispatch, transcription, session state) because there is no MV3 lifecycle to work around. State
that must survive a reload belongs in IndexedDB (`store.js`), not in module-level variables.

## Gate

```bash
node tools/check.mjs       # syntax outside vendor/, every referenced file exists, all unit tests
node --test lib/*.test.js  # the copied modules alone, if iterating on just those
```

Run the gate before claiming any change works, and reload the page (hard refresh, or unregister
the service worker) afterwards — a stale `sw.js` serves the old shell when offline, and the old `vendor/` files until `VENDOR_CACHE` is bumped.

## End-to-end

```bash
node e2e/fixtures.mjs                        # synthesise the 28 conversations + 4 enrollments (macOS `say`)
node e2e/speakers.mjs                        # speaker accuracy: embed in Chrome, replay in Node
node e2e/speakers.mjs --only=paulina-tessa   # embed only fixtures whose name contains this (not with --replay)
node e2e/speakers.mjs --replay=e2e/results/speakers-<date>-vectors.json
                                             # re-decide saved vectors only, no Chrome
node e2e/smoke.mjs                           # consent → settings → enrollment → meeting → Ajustes → Terminar
node e2e/run.mjs Paulina Samantha --condition=room     # the whole app on one conversation, scored per cue
node e2e/run.mjs Mónica Daniel --condition=room
node e2e/run.mjs Paulina Mónica --condition=room       # options: --condition=clean, --delay=<stand-in ms>, --lang=multi
```

`e2e/speakers.mjs` builds any missing fixture, serves the repo in-process, opens
`e2e/speakers.html` in headless Chrome (profile in `e2e/.profile`) and embeds every turn cropped
to 1, 2, 4 s and in full, plus the enrollment print. Node then replays `speaker.js` over the saved
vectors: it calibrates `MATCH_MIN` and `MARGIN` for the `centres` rule by trying every cue of every
clean fixture as the conversation's opening (threshold on a sweep with no gate, margin on a sweep
with it, both on `clean` and both reported back on `room`), and prints accuracy per learner × other
× condition × duration × rule, a summary over same-gender, cross-gender and Spanish-Spanish pairs,
centre poisoning in both directions, before/after the gate on every opening, a threshold-sensitivity
table, mixed segments from `lib/segmenter.js`, and embedding time p50/p90. It also checks
`embed-worker.js` against the page and that the replay reproduces the page's own (pre-gate)
decisions. About 12 minutes for 1 516 embeddings; a `--replay` (no Chrome, no embedding) took 3 min
45 s measured end to end — most of it the two every-opening sweeps, each replaying every cue of
every fixture against all 20 possible openings. The first embedding run downloads the model
(6.7 MB from Hugging Face) and needs network, later runs read it from the profile's cache. Output
goes to `e2e/results/` (git-ignored): `speakers-<date>.json` and the vectors file. Quote its
numbers.

`node e2e/run.mjs Paulina Samantha --condition=room --throttle=4` is the phone stand-in: the page
is slowed 4× with `Emulation.setCPUThrottlingRate`, which DevTools refuses for workers, so the
embed worker holds its thread for 3× each inference's own time (`slowdown` in
`embed-worker.js`, set only through `window.__ec` on 127.0.0.1). The run prints embedding time per
second of speech and how many long segments skipped the window scan. It is not a phone
measurement.

`e2e/run.mjs <learner> <other>` takes about two minutes. It launches headless Chrome twice on
`e2e/.profile` against one loopback port (IndexedDB and the cached voice model are per origin): the
first launch plays `enroll-<learner>-<condition>.wav` into the real enrollment screen, so the print
comes from the app's own code; the second plays the conversation into the real meeting screen, with
Groq replaced by `e2e/mock-groq.mjs` (settings carry a `groqBase`, no UI field) and any request — the page's or its workers' — to a host other than loopback and the model's exact hosts (`huggingface.co`, `us.aws.cdn.hf.co`) failing the run. The stand-in places each received segment on the fixture by sliding its
loudness envelope along the fixture's, and answers with the share of each overlapped cue's words (at least one word from 0.3 s of overlap), so a segment holding both speakers yields mixed text; the arrival-time
guess is logged beside it and the run prints how often the two disagree. It prints, per cue, the
truth against the bubble's speaker, the latency from the cue's end to its last word appearing in a
bubble, and word coverage, then accuracy weighted by words, mixed bubbles (one bubble holding cues of
both speakers), audio-mixed requests (segments whose audio holds both), latency p50/p90, errors and console errors, and saves everything to `e2e/results/` with a timestamped name; it exits non-zero on console errors or error events.
Measured limits: latency is relative to the moment the microphone stream resolved, Chrome
cannot grant tab audio headlessly, and no real transcription is involved: the run measures the
pipeline's labels and timing, never Whisper's accuracy.

## Known debt

- Copied modules (`lib/*`, `recorder-worklet.js`) drift from the extension; `docs/ORIGIN.md`
  names the commit they were taken from.
- The enrollment reads a fixed English text, so the print is built from one language only.
- No live line where on-device recognition is missing (most phones); the meeting still works,
  with Groq transcripts only.
- The speaker model is downloaded from Hugging Face on first use; offline first runs fail.
- One-word backchannels are lost or mislabelled when they share a segment with the other voice.
- The split point of segments of 3 s or more is biased up to 0.75 s early.
- **Open decision:** the spec's Phase 1 criterion "< 10 % mixed segments" is not met. After the
  split, 12–24 % of transcription requests still hold both voices (`audio-mixed requests` in
  `e2e/run.mjs`). Not tuned further; accepting it or working on the cut is the owner's call.
- Each segment's upload starts beside its voice print (Phase 2, Task 2), so a 5b split usually
  arrives after the whole segment's transcription has finished: measured 2026-10-09, every split
  (3 of 3, normal and `--throttle=4`) re-uploaded its parts, 21 requests where 18 did before —
  one wasted Groq request per split, which counts against the free tier's per-minute cap. The
  replaced uploads also appear in `e2e/run.mjs`'s `stand-in requests` (as never reaching a
  bubble) and `audio-mixed requests`. The `labelled` event's `replaced` field records each one.
- The phone CPU cost is emulated (`--throttle=4`), not measured; the scan skip under a backlog
  (`BACKLOG_SKIP_MS` in `session.js`) saves little, because a whole long segment costs about as
  much to embed as its windows.
- Chrome's fake microphone (or the loaded machine) occasionally starves a run: an enrollment
  reported «No te oí lo suficiente», a smoke meeting produced no bubble for 60 s — once each in
  about ten runs on 2026-10-02, under heavy unrelated load; a rerun passed.
- The first run downloads about 31.7 MB (measured: the model 6.7 MB from Hugging Face, plus
  `vendor/transformers.js` 1.3 MB and the ONNX Runtime the worker actually loads,
  `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` 23.6 MB, uncompressed). The enrollment's
  percentage covers the model files only; the runtime downloads under «Cargando el modelo de
  voz…». The non-asyncify `ort-wasm-simd-threaded.{mjs,wasm}` in `vendor/` are never fetched.
- The enrollment voiced floor (10th percentile capped at median / 2.5) and the speaker constants
  (`MATCH_MIN`, `MARGIN`) are calibrated on synthetic voices only; a real-voice check must
  recalibrate them.
- The late-straggler race after «Terminar» is covered by unit tests only.
- Not measured: a real phone, a real voice, real Groq, the browser's own translator.
