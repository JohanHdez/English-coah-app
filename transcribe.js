// Groq's Whisper transcription endpoint. Port of the extension's apiTranscribe
// (coach.js/offscreen.js at ded2c34): same verbose_json handling for a bilingual
// meeting, the same language-name mapping, and the same redaction of anything
// key-shaped out of an error body before it reaches the UI.

import { floatToWav } from './lib/segmenter.js';

const DEFAULT_BASE = 'https://api.groq.com';
const DEFAULT_MODEL = 'whisper-large-v3-turbo';

// Error bodies can echo the request back, and a misbehaving proxy could put the
// Authorization header's value in one.
const KEY_SHAPED = /(gsk_[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|xai-[A-Za-z0-9_-]{6,})/g;
export const redact = (text) => String(text ?? '').replace(KEY_SHAPED, '«API key oculta»');

const baseOf = (base) => (base || DEFAULT_BASE).replace(/\/$/, '');

export async function transcribeGroq(samples, { key, base = DEFAULT_BASE, model = DEFAULT_MODEL, lang = 'en' } = {}) {
  if (!key) throw new Error('[groq] Falta la API key de Groq.');
  const multi = lang === 'multi';
  const form = new FormData();
  form.append('file', floatToWav(samples), 'audio.wav');
  form.append('model', model);
  // In a bilingual meeting the language is the question, not an input: omitting
  // it is what makes Whisper detect it. A single-language session keeps pinning
  // it, which the API documents as better for both accuracy and latency.
  if (!multi) form.append('language', lang === 'es' ? 'es' : 'en');
  // verbose_json is where a detected language can come back; it is not promised,
  // so the caller falls back to null (lib/langid.js decides from the text itself).
  form.append('response_format', multi ? 'verbose_json' : 'json');

  const res = await fetch(`${baseOf(base)}/openai/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`[groq] Groq ${res.status}: ${redact(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const reported = typeof data.language === 'string' ? data.language.toLowerCase() : '';
  // Whisper names languages in English words ("spanish"), not codes.
  const detected = /^(es|spa|spanish|castilian|español)$/.test(reported) ? 'es'
    : /^(en|eng|english|inglés)$/.test(reported) ? 'en'
    : null;
  return { text: data.text || '', lang: detected };
}
