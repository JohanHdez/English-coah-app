// Speaker embeddings with WeSpeaker (ResNet34, VoxCeleb): one 256-dim vector per
// stretch of 16 kHz audio. Measured on 2026-09-29 in headless Chrome, WASM, one
// thread: 2 s embeds in ≈270 ms at q8 against ≈470 ms at fp32.

export const MODEL_ID = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

// Overlapping windows for building a print from a long recording. Hops that stop
// short of the end leave a tail; one last window ending at the final sample
// covers it, so no stretch of the enrollment is ignored.
export function windows(samples, secs = 3, hop = 1.5, sr = 16000) {
  const size = Math.round(secs * sr);
  const step = Math.max(1, Math.round(hop * sr));
  if (samples.length <= size) return [samples];
  const out = [];
  let start = 0;
  for (; start + size <= samples.length; start += step) out.push(samples.subarray(start, start + size));
  if (start - step + size < samples.length) out.push(samples.subarray(samples.length - size));
  return out;
}

// transformers.js is imported lazily so windows() stays importable under node --test.
export async function createEmbedder({ base, dtype = 'q8', onProgress } = {}) {
  const { AutoProcessor, AutoModel, env } = await import(new URL('./vendor/transformers.js', import.meta.url).href);
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = base;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;

  const progress_callback = onProgress || undefined;
  const processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
  const model = await AutoModel.from_pretrained(MODEL_ID, { dtype, device: 'wasm', progress_callback });

  // One inference at a time: the WASM session is single-threaded and not re-entrant.
  let last = Promise.resolve();
  async function run(samples) {
    const inputs = await processor(samples);
    const { last_hidden_state } = await model(inputs);
    return Float32Array.from(last_hidden_state.data);
  }
  return {
    embed(samples) {
      const next = last.then(() => run(samples));
      last = next.catch(() => {});
      return next;
    },
  };
}
