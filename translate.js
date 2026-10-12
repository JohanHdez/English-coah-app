// Spanish translation for the other speaker's English bubbles. The browser's
// built-in Translator (Chrome 138+, as in the extension's translate.js at ded2c34)
// runs on-device and is tried first; the chat provider the learner chose
// (settings.chatProvider, providers.js) is the fallback when it does not exist or
// is unavailable. Either path must never interrupt the meeting:
// every failure resolves to '' rather than throwing, so a bubble simply shows no
// Spanish instead of an error.

import { callChat, migrateSettings } from './providers.js';

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
// Shorter than a transcription's, and never retried: a translation is a
// nice-to-have shown under an already-painted bubble, not worth a stalled
// connection or a staged error.
const TIMEOUT_MS = 15000;

async function chatTranslate(text, settings) {
  try {
    return await callChat(settings, {
      system: SYSTEM_PROMPT,
      user: text,
      stage: '[traducción]',
      retries: 0,
      timeoutMs: TIMEOUT_MS,
    });
  } catch {
    return '';
  }
}

export async function toSpanish(text, settings = {}) {
  if (!text) return '';
  const t = await ensureTranslator();
  if (t) {
    try {
      const out = (await t.translate(text)).trim();
      if (out) return out;
    } catch {
      // Falls through to the chat provider below.
    }
  }
  return chatTranslate(text, migrateSettings(settings));
}

// How the live line's Spanish is fetched: the on-device Translator answers in
// tens of milliseconds and costs nothing, so every finished sentence and the one
// being spoken go to it often; a chat provider counts each call against the
// learner's per-minute limits, so only the line as a whole goes, every 4 s.
export async function liveTranslation(settings = {}) {
  if (await ensureTranslator()) return { translate: (text) => toSpanish(text, settings), sentences: true, gapMs: 300 };
  return { translate: (text) => chatTranslate(text, migrateSettings(settings)), sentences: false, gapMs: 4000 };
}
