# English Coach (PWA)

A web app for phone and desktop that sits on the table during a meeting, listens through one
microphone, tells the learner's voice («Yo») from everyone else's («Interlocutor») by voice
print, and shows the conversation transcribed and translated live, with tap-to-correct and a
manual "I'm speaking" mode. It reuses the pure modules of the English Coach Chrome extension
(`/Users/octopus/Downloads/english-coach`) by copy, not by link — see `docs/ORIGIN.md`.

Full spec: `docs/2026-09-29-plan.md` (Spanish). Phase 1 plan: `docs/2026-09-29-phase1-plan.md`.
Phase 3 plan, task reports and final review: `.superpowers/sdd/2026-10-10-phase3-plan/`.

## Constraints

**No build step. No package.json. No dependencies. No bundler.** Every file that ships is a
file that was written by hand. Node (22+) is for tooling and tests only; the app itself never
runs in Node except through the pure modules under `node --test`. Chrome and Safari load the
files as-is over HTTPS (or `localhost`, a secure context) — nothing here is compiled.

- **Never modify anything under `/Users/octopus/Downloads/english-coach`** (the extension).
  Read it, and copy from a named commit with
  `git -C /Users/octopus/Downloads/english-coach show <commit>:<path> > <dst>`.
- `vendor/` holds copied third-party code (transformers.js + ONNX Runtime Web, and pdf.js under
  `vendor/pdfjs/`, `pdfjs-dist` 6.4.299); never edit it, replace it wholesale from upstream instead
  and update `docs/ORIGIN.md`.
- Pure logic stays pure: `lib/*.js` and (from Task 2) `speaker.js`, `session.js` import nothing
  from the DOM or `chrome`/browser-only APIs and take side effects as injected parameters, so
  they run unmodified under `node --test`. Keep new logic on that side of the line.
- The repository is English: identifiers, comments, documentation, commit messages. The
  **product** is Spanish: every UI string and user-visible error is Spanish. Never "fix" a
  Spanish UI string into English.
- Comments only for what the code cannot say — a browser-imposed behaviour, a measured number,
  a reason a later reader would otherwise have to rediscover. Never restate the code.
- Never pass dynamic content to `innerHTML`; use `textContent` and `createElement`.
- Secrets and biometrics: every provider key and the voice print live in IndexedDB on the device
  and nowhere else. Never log them, never put a key in a URL or query string (Gemini's goes in
  `x-goog-api-key`), never send the voice print anywhere — a key goes only to its own provider's
  host. `providers.js` is the only place a request to a provider is built; a base override
  (`groqBase`, `bases.<id>`, the harness's) and the local provider's `localBase` are honoured only
  for `http://localhost` / `http://127.0.0.1` (plain `http`, because that is what the CSP
  allows). The CSP `connect-src` in `index.html` lists exactly the providers' hosts plus loopback
  over `http` and the model hosts — no `https:` wildcard; `providers.test.js` checks it. It is a
  `<meta>` tag, so it binds the page only: a dedicated worker takes its CSP from its own response
  headers. `tools/serve.mjs` sends the same policy as a `Content-Security-Policy` header (read from
  the meta, so there is one source), and the embed worker, the Whisper preview worker and the service
  worker run under it unchanged (measured 2026-10-10: smoke and `--live=preview`, no console errors).
  A static host must send the same header for workers to be bound by it; until one does,
  `embed-worker.js` and `preview-worker.js` are bound by their code (nothing in them uploads). Claude has no audio input: it is offered for chat only.
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
  `[transcripción]`, `[traducción]`, `[coach]`, `[documentos]`, `[almacenamiento]`; the provider is
  named in the message.
- «Mis documentos» (Phase 3):
  - Documents reach only `askReply` — never `askReport`, translation or transcription. The only
    request-path reader of `store.listDocuments()` is `ui/coach.js`'s «Respuesta».
  - Never store file bytes: `docs-record.js`'s `makeRecord` keeps name, type, size, chars, addedAt,
    enabled and passages. A record is never edited in place except `enabled` — the documents index
    cache in `lib/coach.js` is keyed by the enabled documents' `id:passageCount`, so a document whose
    passages changed under the same id would be searched stale.
  - Document text is untrusted: names go through `textContent` (and `setAttribute` for aria-labels),
    passages through `neutralise` before the prompt, and the block's two delimiter lines are the only
    ones.
  - pdf.js runs with `isEvalSupported: false`, `disableFontFace: true` and no remote resource URL
    (`cMapUrl`, `standardFontDataUrl`, `wasmUrl`); its module worker loads from `vendor/pdfjs/` under
    `worker-src 'self'`.
  - Any parser added must be linear and capped before any regex runs over its input (80 000 spaces
    took 9.9 s through `\s*\n\s*`).
  - The consent text and the «Mis documentos» hint share `DOCUMENTS_SENT` (`docs-record.js`) and must
    say what `documentsBlock` sends. Phase 2 learners never see the consent screen again, so the hint
    is the disclosure they read.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Implementers never dispatch subagents; review is the controller's job.

## File map

| Path | Responsibility | Task |
|---|---|---|
| `lib/segmenter.js` `lib/stitch.js` `lib/queue.js` `lib/langid.js` `lib/live.js` `lib/coach.js` `lib/phrasebook.js` + tests | Copied from the extension, unchanged except import paths, `lib/live.js`'s result joining, `lib/segmenter.js`'s exported `voicedThreshold` / `pushFloor` and its `silenceMs` option (default unchanged, P3-1), and `lib/coach.js`, whose network layer was replaced by `providers.js` (see `docs/ORIGIN.md`) | 1, P2-4, P3-1 |
| `vendor/` | transformers.js + ONNX Runtime Web, copied | 1 |
| `recorder-worklet.js` | Copied: 100 ms blocks with RMS | 1 |
| `tools/serve.mjs` + `tools/serve.test.js` | Local static server (localhost is a secure context, so the mic works); sends the index.html CSP as a response header | 1 |
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
| `capture.js` `transcribe.js` | Microphone + worklet + Segmenter; the meeting's transcription call | 5 |
| `providers.js` + `providers.test.js` | Every AI provider (Groq, OpenAI, Gemini, Claude, local): request shapes, keys, settings migration, the shared timeout/retry/redaction policy | P2-3 |
| `store.js` `translate.js` `ui/*.js` | Device storage, translation, screens | 6 |
| `ui/coach.js` `coachdata.js` + `coachdata.test.js` | The coach panel above the conversation («Frases» / «Notas» / «Contexto», and «Respuesta» taking the same panel) and its pure settings writes; profile and context fields shared with Ajustes | P2-5 |
| `e2e/mock-groq.mjs` `e2e/run.mjs` `e2e/harness.mjs` `e2e/score.mjs` `e2e/smoke.mjs` | The whole app in Chrome with a fake mic and a stand-in for every provider's shapes, scored per cue; a UI smoke test | 6, 7, P2-3 |
| `live-lane.js` + `live-lane.test.js` `preview-worker.js` | Which live line a meeting gets (on-device Web Speech, the install button, the local Whisper preview lane on WebGPU, or a note saying why none) and the preview lane's stitching and slowness rule; the Whisper worker | P2-7 |
| `live-translate.js` + `live-translate.test.js` | The Spanish under the live line: finished sentences once and the one being spoken again, one request at a time, 300 ms apart through the on-device Translator, the whole line every 4 s through a chat provider (`liveTranslation()` in `translate.js`). Measured 2026-10-12 on `--script=long`: 0.06 s behind the English at p50 with the Translator stand-in, 0.78 s through the chat stand-in | 2026-10-12 |
| `lib/markdown.js` + `lib/markdown.test.js` `ui/report.js` | The closing report: a tiny safe markdown renderer (nodes only, never `innerHTML`) and the report block under «Terminar» | P2-6 |
| `docs-extract.js` + test | Text out of a file on the device: PDF through pdf.js (100-page cap, 60 s deadline), DOCX by reading `word/document.xml` out of the zip (`MAX_XML_BYTES` 8 MB inflate cap, encrypted entries refused), TXT/MD as UTF-8; `LIMITS`; `[documentos]` errors; linear parsing, no regex over unbounded whitespace | P3-2 |
| `docs-record.js` + test | The stored record (never the bytes), the 10-document room check, `DOCUMENTS_SENT` (the privacy sentence) | P3-2, P3-3 |
| `lib/passages.js` + test | Pure: split into ~700-character passages (100 overlap), tokenise and stem English/Spanish, BM25 | P3-2, P3-4 |
| `ui/documents.js` | «Mis documentos» in «Ajustes»: add, switch, delete | P3-3 |
| `store.js` | Also the `documents` object store (DB_VERSION 2, keyPath `id`); `onblocked` → «[almacenamiento] Cierra las otras pestañas…», `onversionchange` closes, `tx.onabort` and QuotaExceededError settle every write | P3-3 |
| `lib/coach.js` documents | `documentsQuery`, `documentsBlock` (whole if ≤ 8000, else BM25 picks, else opening passages; index memo), `neutralise`, `DOCUMENTS_MAX_CHARS` | P3-4 |
| `vendor/pdfjs/` | `pdfjs-dist` 6.4.299, three files, sha256 in `docs/ORIGIN.md`; never edited | P3-2 |
| `e2e/docs-fixtures.mjs` `e2e/docs-check.mjs` `e2e/docs-reply.mjs` | Synthetic CV (PDF/DOCX/TXT) and broken files; pdf.js in Chrome under the served CSP; «Respuesta» hit rate and search time in Node; the smoke also attaches, toggles and deletes a document and checks the CV reaches the prompt | P3-2, P3-4 |
| `README.md` `CLAUDE.md` `docs/ORIGIN.md` `docs/BACKLOG.md` | Documentation; the backlog holds requests not yet in a plan | 1, P2-8 |

## Runtime contexts

Four contexts (fewer than the extension: no service-worker-as-router, no offscreen document, no
content script — this is an ordinary web app).

| Context | File(s) | Has | Lacks |
|---|---|---|---|
| Page | `app.js`, `ui/*.js` | DOM, `getUserMedia`, IndexedDB, fetch | nothing browser-standard |
| Dedicated worker | `embed-worker.js` `preview-worker.js` | WASM/WebGPU, ONNX (via `vendor/`) | DOM |
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

Run every harness command under `caffeinate -i`: on 2026-10-09 the Mac idle-slept in the middle of
a run (battery, display off), its audio engine stopped, and the run scored 6/20 cues as if the
pipeline had dropped them. The app now reports that as a lost capture, and `e2e/run.mjs` fails a
run in which it happens (`capture lost` in its totals).

```bash
caffeinate -i node e2e/fixtures.mjs                        # synthesise the 28 conversations + 4 enrollments (macOS `say`)
caffeinate -i node e2e/speakers.mjs                        # speaker accuracy: embed in Chrome, replay in Node
caffeinate -i node e2e/speakers.mjs --only=paulina-tessa   # embed only fixtures whose name contains this (not with --replay)
caffeinate -i node e2e/speakers.mjs --replay=e2e/results/speakers-<date>-vectors.json
                                                           # re-decide saved vectors only, no Chrome
caffeinate -i node e2e/smoke.mjs                           # consent → settings → enrollment → meeting → Ajustes → Terminar
caffeinate -i node e2e/run.mjs Paulina Samantha --condition=room     # the whole app on one conversation, scored per cue
caffeinate -i node e2e/run.mjs Mónica Daniel --condition=room
caffeinate -i node e2e/run.mjs Paulina Mónica --condition=room       # options: --condition=clean, --delay=<stand-in ms>, --lang=multi
caffeinate -i node e2e/run.mjs Paulina Samantha --transcribe=gemini --chat=anthropic   # another provider's request shapes
caffeinate -i node e2e/run.mjs Paulina Samantha --live=speech    # live line: on-device pack installed into e2e/.profile first
caffeinate -i node e2e/run.mjs Paulina Samantha --live=preview   # live line: Web Speech hidden, local Whisper lane (WebGPU)
caffeinate -i node e2e/run.mjs Paulina Samantha --live=none      # Web Speech hidden, lane off: the baseline for its cost
caffeinate -i node e2e/run.mjs Paulina Samantha --live=preview --mobile   # a phone (client hints): the lane must not start
caffeinate -i node e2e/docs-check.mjs                      # pdf.js and the DOCX reader in Chrome under the served CSP
node e2e/docs-reply.mjs [--cv-only|--max]                  # «Respuesta» with documents: hit rate, search time cold/warm (Node only)
```

Names are case-sensitive (`Paulina`, `Mónica`); in zsh quote each pair's names separately, since an
unquoted `$pair` is not word-split. Run one harness process at a time: they share `e2e/.profile`.

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
every provider replaced by `e2e/mock-groq.mjs` (settings carry `groqBase` and `bases.<id>`
loopback overrides, no UI field; `--transcribe=<groq|openai|gemini>` picks whose request shape
carries the audio, `--chat=<id>` turns translation on through that provider with the browser's
Translator hidden, and the run fails if a request reached the wrong shape or its key was not in
that provider's own header) and any request — the page's or its workers' — to a host other than loopback and the model's exact hosts (`huggingface.co`, `us.aws.cdn.hf.co`) failing the run. The stand-in places each received segment on the fixture by sliding its
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
- The live line: where Chrome's on-device pack is `downloadable` the meeting offers «Instalar
  reconocimiento de voz»; where recognition is missing, a device with WebGPU runs
  `onnx-community/whisper-tiny.en` (q4 decoder, fp32 encoder: about 120 MB on first use, from
  Hugging Face) as a preview lane: on by default on a desktop, off on a phone or tablet until the
  learner turns it on in Ajustes (`livePreview` unset follows `isMobile()` in `live-lane.js`;
  `node e2e/run.mjs … --live=preview --mobile` fails if a phone starts it). Measured on 2026-10-09 (this Mac's GPU, not a
  phone's): live text p50 1.05 s after onset, no measurable bubble-latency cost. A phone's GPU may
  trip the slowness rule (two passes over 1.5 s in a row) and retire it, which the screen says.
  Bilingual meetings get no live line. Web Speech itself went silent for 3 s at one speaker change
  in Paulina–Samantha (cue 2, every run).
- Deferred minors from Phase 2 (the final review's triage; the rest were fixed before the friends
  test):
  - Untested in `session.test.js`: a split part's upload failing, `close()` during a split's scan,
    and a scan failure cancelling the whole upload.
  - `lib/markdown.js`: a table swallows a following pipe-containing line; `\|` is unhandled; no
    pathological-input test; the report's reopen path is untested.
  - One desktop harness node process did not exit after saving its results (no children, no sockets),
    uninvestigated.
  - Android's "Desktop site" mode is untested on a device: one Android friend should check that the
    120 MB Whisper lane does not start.
  - The smoke timing flake (Task 1) was never reproduced; re-check it now that runs go under
    `caffeinate -i`.
  - The CSP header is sent only by `tools/serve.mjs`; the deployed host (none chosen yet) must send the
    same policy, or the workers stay bound by their code alone.
  - Closed, not a bug: a split's parts go to the front of the upload queue, but they belong to a
    segment captured before everything queued behind them, so the cap's `shift()` still drops the
    oldest audio.
- Phase 2 measured only on the stand-in and the owner's one desktop test; the real OpenAI, Gemini and
  Claude endpoints were never called, and Groq only for translation latency.
- Claude is chat-only (no audio input).
- The speaker model is downloaded from Hugging Face on first use; offline first runs fail.
- One-word backchannels are lost or mislabelled when they share a segment with the other voice.
- The split point of segments of 3 s or more is placed half a hop (0.375 s) into the first window
  of the new voice, so it can miss the change by up to 0.375 s either way.
- **Open decision:** the spec's Phase 1 criterion "< 10 % mixed segments" is not met. Phase 3,
  Task 1 (measured 2026-10-10, three room fixtures, Groq stand-in) closes a phrase after 450 ms of
  silence (`MIXED_SILENCE_MS` in `capture.js`, passed as the Segmenter's `silenceMs`; the
  extension's default stays 700 ms) and cuts a scanned segment at every surviving change of voice,
  half a hop into the new run: audio-mixed requests 20/64 (31 %) → 11/64 (17 %), mixed bubbles
  8 → 4, accuracy 94.8–95.5 % → 98.1–98.7 %, latency p50 1.45–1.82 s → 1.24–1.30 s. Per pair:
  15 %, 18 %, 18 %. Counting only requests that reached a bubble: 9/44 → 7/45. Each option alone
  (mid-hop cut, every change, 450 ms, 550 ms) and the pairs of them are in
  `.superpowers/sdd/2026-10-10-phase3-plan/task-1-report.md`. Most of the gain is the 450 ms close
  (alone: 14/62); the mid-hop cut and every-change splitting take 14 → 11, within run-to-run noise,
  kept as correctness fixes. The < 10 % criterion is still not met (17 %); accepting it or working
  further on the cut is the owner's call. `e2e/speakers.mjs` segments with the same
  `MIXED_SILENCE_MS`.
- Each segment's upload starts beside its voice print (Phase 2, Task 2), so a 5b split usually
  arrives after the whole segment's transcription has finished: measured 2026-10-09, every split
  (3 of 3, normal and `--throttle=4`) re-uploaded its parts, 21 requests where 18 did before —
  one wasted Groq request per split, which counts against the free tier's per-minute cap. The
  replaced uploads also appear in `e2e/run.mjs`'s `stand-in requests` (as never reaching a
  bubble) and `audio-mixed requests`. The `labelled` event's `replaced` field records each one.
- The phone CPU cost is emulated (`--throttle=4`), not measured; the scan skip under a backlog
  (`BACKLOG_SKIP_MS` in `session.js`) saves little, because a whole long segment costs about as
  much to embed as its windows.
- Starved runs: an enrollment reported «No te oí lo suficiente», a smoke meeting produced no bubble
  for 60 s (once each in about ten runs on 2026-10-02), and a run heard 6/20 cues (2026-10-09). The
  last one is explained: the host Mac idle-slept mid-run and its audio engine stopped (final review,
  section 3, from the run's own results and `pmset -g log`); the earlier two cannot be attributed
  after the fact. Hence `caffeinate -i`, and the app's own stall check (2 s period, 3 s without a
  worklet block → «La captura se detuvo…» with «Reanudar»).
- The first run downloads about 31.7 MB (measured: the model 6.7 MB from Hugging Face, plus
  `vendor/transformers.js` 1.3 MB and the ONNX Runtime the worker actually loads,
  `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` 23.6 MB, uncompressed). The enrollment's
  percentage covers the model files only; the runtime downloads under «Cargando el modelo de
  voz…». The non-asyncify `ort-wasm-simd-threaded.{mjs,wasm}` in `vendor/` are never fetched.
- The enrollment voiced floor (10th percentile capped at median / 2.5) and the speaker constants
  (`MATCH_MIN`, `MARGIN`) are calibrated on synthetic voices only; a real-voice check must
  recalibrate them.
- The late-straggler race after «Terminar» is covered by unit tests only.
- Not measured: a real phone, a real voice, any real provider API (Groq, OpenAI, Gemini, Claude,
  a local server), the browser's own translator. The adapters follow the providers' documentation
  as read on 2026-10-09 and the stand-in answers those shapes; neither proves a real endpoint
  accepts them.
- Gemini transcription reports no language (`lang: null`, and OpenAI's json models may not either),
  so in a bilingual meeting `session.js`'s `turnLang` decides from the text with `lib/langid.js`
  (confidence ≥ 0.5, otherwise the speaker's previous language; a pinned meeting is its own
  language); Gemini 3.x Flash models think by default, which may
  add latency per segment — not measured.
- The default chat models (`openai/gpt-oss-120b` on Groq) are reasoning models; translation now
  uses them instead of Phase 1's `llama-3.1-8b-instant`. Measured on the real Groq (synthetic
  sentences): p50 0.80 s per bubble (`openai/gpt-oss-20b` 0.55 s); the other providers' are not.
- «Mis documentos», measured 2026-10-10 (`node e2e/docs-reply.mjs`, synthetic CV, five questions):
  CV alone 5/5 (sent whole); CV + 80 distractor notes 4/5; at the limits (10 × 200 000 characters,
  3432 passages) the first «Respuesta» after a change builds the index, median 121–137 ms (two runs), later
  ones 2.1–2.5 ms (Node, this Mac; a phone is slower and this runs on the page's thread). PDF, 2
  pages: 158–427 ms cold (1073 ms fresh profile), 70 ms warm. Limits: 10 documents, 2 MB, 200 000
  characters, 100 PDF pages, 60 s per PDF, 8000 characters per «Respuesta». `MIXED_SILENCE_MS` is
  450 ms against the extension's 700 ms.
- Retrieval is lexical (BM25 over stemmed words): «Where did you study?» misses a CV's «Education»
  in a long corpus (4/5).
- Stemmer quirks (`lib/passages.js`): news→new, speed→spe, sesión/sesiones and lideré/liderar do
  not meet; "payments"→"pay".
- Passages overlap by up to 100 characters, so the repeated text counts against the 8000, and a
  document of ~7500–8000 characters can miss the "send whole" rule.
- Hidden PDF text (white, off-page) is extracted and can reach the reply prompt verbatim. Containment:
  plain-text reply, no link sink, CSP images `'self' data:`, the report excluded — worst case a
  steered suggestion.
- A FlateDecode bomb inside one PDF content stream cannot be bounded through pdf.js options; only the
  60 s deadline ends it (the file is the learner's own choice). A DOCX of 1.3 M `<w:p/>` tags costs a
  linear 430 ms before the character cap stops it.
- Bilingual meetings (`--lang=multi`) were not re-measured with the 450 ms close; shorter segments
  give the per-segment language decision less audio (needs a `--real` bilingual run).
- No «Borrar todos mis documentos»; documents survive «Borrar mi huella de voz», «Borrar la
  conversación guardada» and re-enrolment (by design; README says so). The first PDF added offline
  fails: pdf.js is cached on first use.
- The documents path's Chrome smoke covers attach / toggle / delete, the row names and one prompt
  assertion only; `store.js`'s blocked/abort/quota paths are not exercised by any test.
- `gpt-4o-mini-transcribe` (OpenAI's default) is announced for removal on 2027-02-26; its
  replacement `gpt-transcribe` takes `languages` instead of `language` (the adapter sends neither
  for it).
