// Delivers audio in 100 ms blocks (1600 samples at 16 kHz) together with their RMS.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1600;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        const copy = new Float32Array(this.buf);
        let sum = 0;
        for (let j = 0; j < copy.length; j++) sum += copy[j] * copy[j];
        this.port.postMessage({ samples: copy, rms: Math.sqrt(sum / copy.length) }, [copy.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
