import { createEmbedder } from './embed.js';

let embedder = null;

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      embedder = await createEmbedder({
        base: data.base,
        onProgress: (p) => self.postMessage({ type: 'progress', ...p }),
      });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: `[huella] ${err?.message || err}` });
    }
  } else if (data.type === 'embed') {
    if (!embedder) {
      self.postMessage({ type: 'error', id: data.id, message: '[huella] modelo no cargado' });
      return;
    }
    try {
      const vector = await embedder.embed(data.samples);
      self.postMessage({ type: 'vector', id: data.id, vector }, [vector.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id: data.id, message: `[huella] ${err?.message || err}` });
    }
  }
};
