// Spanish translation for the other speaker's English bubbles. The browser's
// built-in Translator (Chrome 138+, as in the extension's translate.js at ded2c34)
// runs on-device and is tried first; Groq chat completions is the fallback when it
// does not exist or is unavailable. Either path must never interrupt the meeting:
// every failure resolves to '' rather than throwing, so a bubble simply shows no
// Spanish instead of an error.

let translator = null;
let state = 'idle'; // idle | ready | unavailable

async function ensureTranslator() {
  if (state === 'ready') return translator;
  if (state === 'unavailable') return null;
  if (typeof Translator === 'undefined') { state = 'unavailable'; return null; }
  try {
    const opts = { sourceLanguage: 'en', targetLanguage: 'es' };
    if ((await Translator.availability(opts)) === 'unavailable') {
      state = 'unavailable';
      return null;
    }
    translator = await Translator.create(opts);
    state = 'ready';
    return translator;
  } catch {
    state = 'unavailable';
    return null;
  }
}

const SYSTEM_PROMPT = "Translate the user's English text into natural Latin American Spanish. Reply with the translation only.";
const DEFAULT_BASE = 'https://api.groq.com';
const baseOf = (base) => (base || DEFAULT_BASE).replace(/\/$/, '');
// Shorter than transcribeGroq's: a translation is a nice-to-have shown under an
// already-painted bubble, not something worth tying up a stalled connection for.
const TIMEOUT_MS = 15000;

async function groqTranslate(text, { key, base } = {}) {
  if (!key) return '';
  try {
    const res = await fetch(`${baseOf(base)}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch {
    return '';
  }
}

export async function toSpanish(text, { key, base } = {}) {
  if (!text) return '';
  const t = await ensureTranslator();
  if (t) {
    try {
      const out = (await t.translate(text)).trim();
      if (out) return out;
    } catch {
      // Falls through to Groq below.
    }
  }
  return groqTranslate(text, { key, base });
}
