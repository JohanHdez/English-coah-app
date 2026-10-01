// Delivers audio in 100 ms blocks (1600 samples at 16 kHz) together with their
// RMS. Modified from the extension's copy (see docs/ORIGIN.md): some browsers
// ignore the `sampleRate` requested of an AudioContext (and Firefox refuses to
// connect a MediaStreamSource to a context whose rate differs from the
// device's), so `capture.js` always tells this processor the context's real
// rate via `processorOptions.inputRate`, and this file linearly resamples to
// 16 kHz before anything downstream (the Segmenter, the 16 kHz contract every
// other module in this repo assumes) ever sees a sample.

const OUT_RATE = 16000;
const OUT_SIZE = 1600; // 100 ms at 16 kHz

// Pure so it can be driven by node --test: `pending` is whatever input samples
// were read into but not yet fully consumed by the previous call, and `cursor`
// is the fractional read position left over from it. Returns the resampled
// output plus the new `pending`/`cursor` to carry into the next render quantum.
export function resampleChunk(pending, chunk, ratio, cursor) {
  const combined = new Float32Array(pending.length + chunk.length);
  combined.set(pending, 0);
  combined.set(chunk, pending.length);

  const out = [];
  let c = cursor;
  while (Math.floor(c) + 1 < combined.length) {
    const i0 = Math.floor(c);
    const frac = c - i0;
    out.push(combined[i0] * (1 - frac) + combined[i0 + 1] * frac);
    c += ratio;
  }
  // Clamped: the loop's last step can land `c` past the end of `combined`
  // (e.g. ratio 3 over a 128-sample block puts `c` at 129). `.slice()` on an
  // over-length index silently clamps to empty, but the *cursor* must not —
  // an un-clamped `consumedTo` here throws away the fractional offset still
  // owed into the next chunk, desyncing the interpolation on (almost) every
  // render quantum for any ratio that does not evenly divide 128.
  const consumedTo = Math.min(Math.floor(c), combined.length);
  return {
    samples: Float32Array.from(out),
    pending: combined.slice(consumedTo),
    cursor: c - consumedTo,
  };
}

// Guarded so `resampleChunk` above stays importable under node --test:
// `AudioWorkletProcessor` only exists inside a real AudioWorklet global scope,
// and merely evaluating `class ... extends AudioWorkletProcessor` outside one
// throws (embed.js's lazy transformers.js import is the same idea, applied to
// a global instead of a module).
if (typeof AudioWorkletProcessor !== 'undefined') {
  class RecorderProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const inputRate = options?.processorOptions?.inputRate || OUT_RATE;
      this.ratio = inputRate / OUT_RATE;
      this.pending = new Float32Array(0);
      this.cursor = 0;
      this.buf = new Float32Array(OUT_SIZE);
      this.n = 0;
    }

    process(inputs) {
      const input = inputs[0];
      if (!input || input.length === 0) return true;
      const ch = input[0];
      if (!ch) return true;

      // The common case (the context actually opened at 16 kHz) skips the
      // resampler entirely, so it costs nothing and changes no sample value.
      if (this.ratio === 1) {
        this.append(ch);
      } else {
        const { samples, pending, cursor } = resampleChunk(this.pending, ch, this.ratio, this.cursor);
        this.pending = pending;
        this.cursor = cursor;
        this.append(samples);
      }
      return true;
    }

    append(samples) {
      for (let i = 0; i < samples.length; i++) {
        this.buf[this.n++] = samples[i];
        if (this.n === this.buf.length) this.emit();
      }
    }

    emit() {
      const copy = new Float32Array(this.buf);
      let sum = 0;
      for (let j = 0; j < copy.length; j++) sum += copy[j] * copy[j];
      this.port.postMessage({ samples: copy, rms: Math.sqrt(sum / copy.length) }, [copy.buffer]);
      this.n = 0;
    }
  }

  registerProcessor('recorder-processor', RecorderProcessor);
}
