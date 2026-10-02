# English Coach (PWA)

A web app for phone and desktop that sits on the table during a meeting and listens through one
microphone. It tells the learner's voice («Yo») from everyone else's («Interlocutor») by voice
print, shows the conversation transcribed in English with a Spanish translation under the other
speaker's bubbles, and lets the learner correct a wrong label by tapping, or switch to a manual
"I'm speaking" mode.

The product is Spanish (every label and error the user sees); the repository is English. The
approved spec is `docs/2026-09-29-plan.md` (Spanish); the phase 1 plan is
`docs/2026-09-29-phase1-plan.md`.

## Who it is for

Spanish speakers who take part in meetings held in English and want to follow what the other
person says and see how their own English was transcribed. It reuses the pure modules of the
English Coach Chrome extension by copy (see `docs/ORIGIN.md`).

## Run it locally

No build step, no `package.json`, no dependencies. Node 22+ is needed for tooling only.

```bash
node tools/serve.mjs          # http://localhost:5173 (pass a port as the first argument)
node tools/check.mjs          # the gate: syntax, referenced files, unit tests
```

`localhost` is a secure context, so the microphone works over plain HTTP there. On first run the
app asks for consent, a Groq API key («Ajustes») and a voice enrollment, then shows «Empezar
reunión»: a meeting starts on that tap (browsers only run audio started by a gesture), or on
«Continuar» when an unfinished conversation is waiting.

The first run downloads about **31.7 MB** (measured on 2026-10-02, uncompressed): the speaker model
(6.7 MB, Hugging Face) and the app's own speech runtime (`vendor/`: transformers.js 1.3 MB and the
ONNX Runtime WASM the browser actually loads, 23.6 MB). Use Wi-Fi the first time. The enrollment
screen shows a percentage for the model files only; the runtime downloads while it says «Cargando
el modelo de voz…». Both are cached afterwards (the model by transformers.js, `vendor/` by the
service worker).

## Use it on a phone

A phone needs HTTPS to grant microphone access and to install the app. Any static host works
(GitHub Pages included): serve the repository folder as-is. This is not set up yet; where to
host it is the owner's decision.

## Privacy

| Stays on the device | Goes out |
|---|---|
| The Groq API key and your voice print (IndexedDB). The voice print is never sent anywhere. | Audio segments of the meeting go to Groq (`whisper-large-v3-turbo`) for transcription, using your own key, sent only to Groq's host — only while the meeting runs: after «Terminar», segments not yet sent are dropped and uploads still in flight are cancelled. |
| The last conversation's transcript, with its Spanish translations (IndexedDB), until you delete it in «Ajustes» or start a new meeting. | |
| Speaker embeddings: computed in the browser with the WeSpeaker model (WASM). | The first use downloads the speaker model (6.7 MB) from Hugging Face and the app's runtime (25 MB) from the app's own host; both are cached. |
| Translation, when the browser has its own Translator (Chrome 138+). | Without it, translation falls back to Groq chat completions with the other speaker's text. |
| The live line (word-by-word preview) uses the browser's on-device recognition only; if that is missing, the live line stays off. | Nothing else. The service worker caches the app shell and `vendor/`, never audio or Groq responses. |

**When Groq struggles.** A transcription that fails with 429, a 5xx or a dropped connection is
retried twice (1 s, then 2 s, or the server's `Retry-After`, capped at 8 s); other 4xx are not
retried. At most two uploads run at once; when more than 10 s of audio is waiting the screen says
«Groq va con retraso…», and past 60 s of waiting audio the oldest segment is dropped with a
visible error instead of letting memory and delay grow (a minute of audio is 3.8 MB, and a bubble a
minute late is no use in a live conversation). Translations run one at a time.

## Measured numbers

All on synthetic voices (macOS `say`). Nothing below was measured with a real phone, a real
person, real Groq, or the browser's own translator.

**Speaker separation** (`node e2e/speakers.mjs`; room condition: the other voice through a
simulated laptop speaker; every turn tried as the opening; `MATCH_MIN` 0.50, `MARGIN` 0.11, rule
`centres`):

| Pairs | Correct at 2 s of audio |
|---|---|
| Same gender | 96 % |
| Cross gender | 100 % |
| Spanish-Spanish | 98 % |

A 2 s embedding takes 259 ms p50 / 270 ms p90 in headless desktop Chrome (WASM, one thread).

**Mixed segments — criterion not met, open decision.** Before splitting long segments, 28.5 % of
segments mixed both voices (the energy segmenter waits 700 ms of silence). The app now splits
segments of 3 s or more once, by voice windows, and 12–24 % of transcription requests still hold
both voices (`audio-mixed requests` in `e2e/run.mjs`). The spec's Phase 1 criterion is < 10 %: it is
**not met**. Whether to accept it or keep working on the cut is the owner's decision.

**The whole app** (`node e2e/run.mjs`, room condition, Groq stand-in with a 0.9 s delay, accuracy
weighted by words):

| Learner / other | Speaker accuracy |
|---|---|
| Paulina / Samantha | 94.9 % |
| Mónica / Daniel | 94.8 % |
| Paulina / Mónica | 98.1 % |

Per 60 s meeting: 2-3 mixed bubbles. Bubble latency after the speaker stops: p50 2.5-2.6 s, p90
7.3-7.4 s. The one-word «Yes.» turn was missed in all three runs. The stand-in measures labels and
timing, never Whisper's accuracy.

Those three rows predate the 2026-10-02 fixes (tap to start, native audio rate, window-mean
reuse). Re-measured after them, Paulina / Samantha: 93.6 %, latency p50 2.1 s · p90 6.8 s, 4/18
audio-mixed requests, embedding 282 ms per second of speech. Four runs of this code the same day
gave 93.6–94.9 %; the previous commit gave 96.2 % once. The wrong cues are the same short turns
(«Okay, sure.», «Yes.», «Right, exactly.»).

**Phone CPU, emulated** (`node e2e/run.mjs Paulina Samantha --condition=room --throttle=4`: page
slowed 4× by DevTools, embed worker held 3× its own inference time; not a phone): 94.9 %, latency
p50 11.5 s · p90 15.8 s, embedding 1 129 ms per second of speech — over real time. Once embedding
trails the speaker by more than 4 s, long segments skip the window scan (4/11 did), but that saves
little: embedding a whole long segment costs about as much as its windows. A real Android phone and
iPhone still have to be measured.

## Known limits

- Short turns: a one-word reply sharing a segment with the other voice is lost or mislabelled.
- Overlapping speech is not separated; a segment of 3 s or more is split at most once, into two
  parts at the first change of voice, and anything mixed beyond that keeps one label.
- The screen should stay on: the page owns the session, and on most phones a locked screen or a
  backgrounded app stops the microphone (platform behaviour, not measured on a device here). When
  the app comes back it checks the microphone and the audio engine; if capture stopped it says
  «La captura se detuvo mientras la app estaba en segundo plano.» and offers «Reanudar», which
  continues the same meeting.
- Synthetic voices are more stable than people. The thresholds are calibrated on them and must be
  recalibrated with real voices.
- The tab or a remote call is not captured; only what the microphone hears.

## Layout

`CLAUDE.md` holds the constraints, the file map, the gate and the end-to-end commands.
Third-party code is in `THIRD-PARTY-NOTICES.md`; the licence is in `LICENSE`.
