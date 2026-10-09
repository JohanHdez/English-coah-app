// The live line's local stand-in where the browser has no on-device recogniser:
// Whisper on WebGPU, over the tail of the phrase still being spoken. What it
// returns is provisional display text; the page never stores it or sends it on.

const PREVIEW_MODEL = 'onnx-community/whisper-tiny.en';

// The extension's load ladder without its WASM rungs: on the CPU a pass takes
// seconds and the lane would retire itself after two of them, having cost the
// embedding worker the CPU meanwhile. The vendored ONNX Runtime (1.26) rejects the
// q8 Whisper exports ("Missing required scale … MatMulNBits"), so q4 comes first.
const ATTEMPTS = [['webgpu', 'q4'], ['webgpu', 'fp32']];

let transcriber = null;

async function load({ base, model }) {
  const { pipeline, env } = await import(new URL('./vendor/transformers.js', import.meta.url).href);
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = base;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  if (!('gpu' in navigator) || !(await navigator.gpu.requestAdapter())) throw new Error('sin WebGPU');
  let lastErr = null;
  for (const [device, decoder] of ATTEMPTS) {
    try {
      transcriber = await pipeline('automatic-speech-recognition', model || PREVIEW_MODEL, {
        device,
        dtype: { encoder_model: 'fp32', decoder_model_merged: decoder },
      });
      // The first pass on WebGPU compiles its shaders: measured 4.4 s against a
      // p50 of 0.6 s, enough to count against the slowness rule and leave the
      // first sentence of the meeting blank. One second of silence pays it here.
      await transcriber(new Float32Array(16000), { return_timestamps: false });
      return `${device}/${decoder}`;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no se pudo cargar el modelo');
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const device = await load(data);
      self.postMessage({ type: 'ready', device });
    } catch (err) {
      self.postMessage({ type: 'error', message: `[en vivo] ${err?.message || err}` });
    }
  } else if (data.type === 'transcribe') {
    try {
      if (!transcriber) throw new Error('modelo no cargado');
      const out = await transcriber(data.audio, { return_timestamps: false });
      self.postMessage({ type: 'result', id: data.id, text: out?.text || '' });
    } catch (err) {
      self.postMessage({ type: 'error', id: data.id, message: `[en vivo] ${err?.message || err}` });
    }
  }
};
