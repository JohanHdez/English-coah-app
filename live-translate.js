// Spanish that follows the live line while the other person is still talking.
// Pure: the translator, the clock and the timers are injected, so it runs under
// node --test. Finished sentences are translated once and kept; only the
// sentence still being spoken is re-sent, at most one request at a time and no
// sooner than `gapMs` after the previous one — a provider's per-minute limits
// are shared with the bubbles' own translations and with «Respuesta». With
// `sentences: false` (a provider, not the on-device Translator) the whole line
// is the one re-sent text: no extra request per finished sentence, since the
// bubble brings the final translation anyway.

const SENTENCE = /[^.!?…]+[.!?…]+["'”’)\]]*\s+/gy;

export function splitSentences(text) {
  const src = String(text || '');
  const done = [];
  SENTENCE.lastIndex = 0;
  let end = 0;
  let m;
  while ((m = SENTENCE.exec(src))) {
    done.push(m[0].trim());
    end = SENTENCE.lastIndex;
  }
  return { done, tail: src.slice(end).trim() };
}

// The recogniser revises its last words as it goes; a translation still
// belongs to the line while the two agree on how they start.
function sameStart(a, b) {
  const n = Math.min(12, a.length, b.length);
  return n > 0 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

export function createLiveTranslator({ translate, onText, sentences = true, gapMs = 400, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const cache = new Map();
  const asked = new Set();
  let latest = { done: [], tail: '' };
  let tailEs = { src: '', es: '' };
  let tailBusy = false;
  let tailAskedAt = -Infinity;
  let timer = null;
  let generation = 0;
  let shown = '';

  function paint() {
    const parts = latest.done.map((s) => cache.get(s) ?? (tailEs.es && sameStart(s, tailEs.src) ? tailEs.es : ''));
    if (latest.tail && tailEs.es && sameStart(latest.tail, tailEs.src)) parts.push(tailEs.es);
    const text = parts.filter(Boolean).join(' ');
    if (text !== shown) {
      shown = text;
      onText(text);
    }
  }

  function askSentence(s) {
    if (asked.has(s)) return;
    asked.add(s);
    const gen = generation;
    Promise.resolve(translate(s)).catch(() => '').then((es) => {
      if (gen !== generation) return;
      if (es) cache.set(s, es);
      else asked.delete(s);
      paint();
    });
  }

  function askTail() {
    timer = null;
    const src = latest.tail;
    if (!src || tailBusy || src === tailEs.src) return;
    const wait = tailAskedAt + gapMs - now();
    if (wait > 0) {
      timer = setTimer(askTail, wait);
      return;
    }
    tailBusy = true;
    tailAskedAt = now();
    const gen = generation;
    Promise.resolve(translate(src)).catch(() => '').then((es) => {
      if (gen !== generation) return;
      tailBusy = false;
      if (es) tailEs = { src, es };
      paint();
      if (latest.tail !== src && !timer) askTail();
    });
  }

  return {
    update(text) {
      latest = sentences ? splitSentences(text) : { done: [], tail: String(text || '').trim() };
      for (const key of asked) if (!latest.done.includes(key)) { asked.delete(key); cache.delete(key); }
      for (const s of latest.done) askSentence(s);
      if (!timer) askTail();
      paint();
    },
    clear() {
      generation++;
      if (timer) clearTimer(timer);
      timer = null;
      cache.clear();
      asked.clear();
      latest = { done: [], tail: '' };
      tailEs = { src: '', es: '' };
      tailBusy = false;
      paint();
    },
  };
}
