import { createEmbedder } from './embed.js';

let embedder = null;
// Loopback harness only (e2e/run.mjs --throttle): DevTools CPU throttling reaches
// the page but not a dedicated worker, so a phone-speed worker is emulated by
// holding the thread for (slowdown − 1)× each inference's own time.
let slowdown = 1;

function hold(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* busy, like a slower CPU */ }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    slowdown = Math.max(1, Number(data.slowdown) || 1);
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
      const t0 = performance.now();
      const vector = await embedder.embed(data.samples);
      if (slowdown > 1) hold((performance.now() - t0) * (slowdown - 1));
      self.postMessage({ type: 'vector', id: data.id, vector }, [vector.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id: data.id, message: `[huella] ${err?.message || err}` });
    }
  }
};
