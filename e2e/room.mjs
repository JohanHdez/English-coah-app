// Pure DSP for synthetic meetings: what a phone on the table hears from a laptop
// speaker and from the learner sitting next to it. Deterministic by seed.

export function prng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// RBJ cookbook biquad.
export function biquad(x, type, f0, q, sr = 16000) {
  const w = 2 * Math.PI * f0 / sr;
  const c = Math.cos(w);
  const a = Math.sin(w) / (2 * q);
  const [b0, b1, b2] = type === 'lowpass' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const yn = (b0 * x[n] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    y[n] = yn;
    x2 = x1; x1 = x[n]; y2 = y1; y1 = yn;
  }
  return y;
}

// Schroeder reverb: four parallel combs and two allpasses, linear time, which a
// convolution with a 0.3 s impulse over minutes of audio is not.
export function reverb(x, rt60, mixAmount, sr = 16000) {
  const combs = [29.7, 37.1, 41.1, 43.7].map((ms) => Math.round(ms * sr / 1000));
  const wet = new Float32Array(x.length);
  for (const d of combs) {
    const g = Math.pow(10, (-3 * d) / (rt60 * sr));
    const buf = new Float32Array(d);
    let i = 0;
    for (let n = 0; n < x.length; n++) {
      const out = buf[i];
      buf[i] = x[n] + out * g;
      wet[n] += out / combs.length;
      i = (i + 1) % d;
    }
  }
  let y = wet;
  for (const [ms, g] of [[5, 0.7], [1.7, 0.7]]) {
    const d = Math.round(ms * sr / 1000);
    const buf = new Float32Array(d);
    const out = new Float32Array(y.length);
    let i = 0;
    for (let n = 0; n < y.length; n++) {
      const delayed = buf[i];
      const v = y[n] + g * delayed;
      out[n] = delayed - g * v;
      buf[i] = v;
      i = (i + 1) % d;
    }
    y = out;
  }
  const res = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) res[n] = x[n] * (1 - mixAmount) + y[n] * mixAmount;
  return res;
}

export function noise(length, dbfs, seed) {
  const r = prng(seed);
  const amp = Math.pow(10, dbfs / 20);
  return biquad(Float32Array.from({ length }, () => (r() * 2 - 1) * amp * 1.7), 'lowpass', 1500, 0.707);
}

export function gainDb(x, db) {
  const g = Math.pow(10, db / 20);
  return Float32Array.from(x, (v) => v * g);
}

export function mix(a, b) {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let n = 0; n < out.length; n++) out[n] = (a[n] || 0) + (b[n] || 0);
  return out;
}

// A laptop speaker across the table: no bass, no air, a small resonance, the room
// around it, and 10 dB below a voice at arm's length.
export function laptopSpeaker(x, seed) {
  let y = biquad(x, 'highpass', 300, 0.707);
  y = biquad(y, 'lowpass', 6000, 0.707);
  y = reverb(y, 0.3, 0.35);
  return mix(gainDb(y, -10), noise(y.length, -60, seed));
}

// The learner at arm's length from the phone: mostly direct sound, a short room tail.
export function nearVoice(x, seed) {
  return mix(reverb(x, 0.15, 0.15), noise(x.length, -60, seed));
}
