# Origin of copied files

These files are copies, not links, from the English Coach Chrome extension
(`/Users/octopus/Downloads/english-coach`), at commit `ded2c34`. A fix made here
or in the extension is ported by hand; the two do not share history.

| File | Source path | Commit |
|---|---|---|
| `lib/segmenter.js` | `segmenter.js` | `ded2c34` |
| `lib/segmenter.test.js` | `segmenter.test.js` | `ded2c34` |
| `lib/stitch.js` | `stitch.js` | `ded2c34` |
| `lib/stitch.test.js` | `stitch.test.js` | `ded2c34` |
| `lib/queue.js` | `queue.js` | `ded2c34` |
| `lib/queue.test.js` | `queue.test.js` | `ded2c34` |
| `lib/langid.js` | `langid.js` | `ded2c34` |
| `lib/langid.test.js` | `langid.test.js` | `ded2c34` |
| `lib/live.js` | `live.js` | `ded2c34` |
| `lib/live.test.js` | `live.test.js` | `ded2c34` |
| `recorder-worklet.js` | `recorder-worklet.js` | `ded2c34` (modified, see note below) |
| `vendor/transformers.js` | `vendor/transformers.js` | `ded2c34` |
| `vendor/ort-wasm-simd-threaded.mjs` | `vendor/ort-wasm-simd-threaded.mjs` | `ded2c34` |
| `vendor/ort-wasm-simd-threaded.wasm` | `vendor/ort-wasm-simd-threaded.wasm` | `ded2c34` |
| `vendor/ort-wasm-simd-threaded.asyncify.mjs` | `vendor/ort-wasm-simd-threaded.asyncify.mjs` | `ded2c34` |
| `vendor/ort-wasm-simd-threaded.asyncify.wasm` | `vendor/ort-wasm-simd-threaded.asyncify.wasm` | `ded2c34` |
| `e2e/cdp.mjs` | `e2e/cdp.mjs` | `ded2c34` |
| `e2e/mock-groq.mjs` | `e2e/mock-groq.mjs` | `ded2c34` |
| `LICENSE` | `LICENSE` | `ded2c34` |
| `THIRD-PARTY-NOTICES.md` | `THIRD-PARTY-NOTICES.md` | `ded2c34` |

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
