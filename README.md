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
app asks for consent, a Groq API key («Ajustes») and a voice enrollment, then starts a meeting.

## Use it on a phone

A phone needs HTTPS to grant microphone access and to install the app. Any static host works
(GitHub Pages included): serve the repository folder as-is. This is not set up yet; where to
host it is the owner's decision.

## Privacy

| Stays on the device | Goes out |
|---|---|
| The Groq API key and your voice print (IndexedDB). The voice print is never sent anywhere. | Audio segments of the meeting go to Groq (`whisper-large-v3-turbo`) for transcription, using your own key, sent only to Groq's host. |
| Speaker embeddings: computed in the browser with the WeSpeaker model (WASM). | The first use downloads the speaker model (6.7 MB) from Hugging Face, then it is cached. |
| Translation, when the browser has its own Translator (Chrome 138+). | Without it, translation falls back to Groq chat completions with the other speaker's text. |
| The live line (word-by-word preview) uses the browser's on-device recognition only; if that is missing, the live line stays off. | Nothing else. The service worker caches the app shell only, never audio. |

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

**Mixed segments.** Before splitting long segments, 28.5 % of segments mixed both voices (the
energy segmenter waits 700 ms of silence). The app now splits segments of 3 s or more by voice
windows.

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

## Known limits

- Short turns: a one-word reply sharing a segment with the other voice is lost or mislabelled.
- Overlapping speech is not separated; a segment holding both voices gets one label per window at best.
- The screen must stay on: the page owns the session, and a locked phone suspends it.
- Synthetic voices are more stable than people. The thresholds are calibrated on them and must be
  recalibrated with real voices.
- The tab or a remote call is not captured; only what the microphone hears.

## Layout

`CLAUDE.md` holds the constraints, the file map, the gate and the end-to-end commands.
Third-party code is in `THIRD-PARTY-NOTICES.md`; the licence is in `LICENSE`.
