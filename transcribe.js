// Groq's Whisper transcription endpoint. Port of the extension's apiTranscribe
// (coach.js/offscreen.js at ded2c34): same verbose_json handling for a bilingual
// meeting, the same language-name mapping, and the same redaction of anything
// key-shaped out of an error body before it reaches the UI.

import { floatToWav } from './lib/segmenter.js';

const DEFAULT_BASE = 'https://api.groq.com';
const DEFAULT_MODEL = 'whisper-large-v3-turbo';
// A stalled request (a dead mobile connection mid-upload) must not hang
// session.drain() forever — AbortSignal.timeout turns it into an ordinary
// fetch rejection, caught and staged exactly like any other network failure.
const TIMEOUT_MS = 30000;

// Two retries after the first attempt. Groq's free tier answers 429 when a lively
// meeting outruns its per-minute request cap; a few seconds later the same request
// succeeds, and the words would otherwise be lost for good.
export const RETRIES = 2;
const BACKOFF_BASE_MS = 1000;
// A Retry-After longer than this is not worth honouring mid-meeting: the session
// queue keeps filling behind the wait, and the bubble would land too late to read.
export const MAX_WAIT_MS = 8000;

// Error bodies can echo the request back, and a misbehaving proxy could put the
// Authorization header's value in one.
const KEY_SHAPED = /(gsk_[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|xai-[A-Za-z0-9_-]{6,})/g;
export const redact = (text) => String(text ?? '').replace(KEY_SHAPED, '«API key oculta»');

const baseOf = (base) => (base || DEFAULT_BASE).replace(/\/$/, '');

export const isRetryableStatus = (status) => status === 429 || (status >= 500 && status <= 599);

// Retry-After is either delta-seconds or an HTTP date (RFC 9110 §10.2.3).
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  // Date.parse accepts bare numbers ("-3" is the year -3); an HTTP date has a weekday.
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

// attempt is 0 for the wait before the first retry.
export function retryDelayMs(attempt, retryAfterMs = null) {
  const backoff = BACKOFF_BASE_MS * 2 ** attempt;
  const wanted = retryAfterMs === null ? backoff : Math.max(retryAfterMs, 0);
  return Math.min(wanted, MAX_WAIT_MS);
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(abortError(signal)); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout(signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (!signal) return timeout;
  if (AbortSignal.any) return AbortSignal.any([signal, timeout]);
  // Safari before 17.4 has no AbortSignal.any.
  const both = new AbortController();
  for (const s of [signal, timeout]) s.addEventListener('abort', () => both.abort(s.reason), { once: true });
  return both.signal;
}

function statusMessage(status, body) {
  if (status === 401) return '[groq] Clave de Groq no válida.';
  if (status === 429) return '[groq] Groq está limitando las peticiones (429); se perdió un fragmento.';
  return `[groq] Groq ${status}: ${redact(body).slice(0, 200)}`;
}

// `signal` belongs to the session: it fires when the meeting is finished, and
// nothing may be uploaded or retried after that.
export async function transcribeGroq(samples, { key, base = DEFAULT_BASE, model = DEFAULT_MODEL, lang = 'en', signal, sleep = waitFor } = {}) {
  if (!key) throw new Error('[groq] Falta la API key de Groq.');
  const multi = lang === 'multi';
  const wav = floatToWav(samples);
  const url = `${baseOf(base)}/openai/v1/audio/transcriptions`;

  let res;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    const form = new FormData();
    form.append('file', wav, 'audio.wav');
    form.append('model', model);
    // In a bilingual meeting the language is the question, not an input: omitting
    // it is what makes Whisper detect it. A single-language session keeps pinning
    // it, which the API documents as better for both accuracy and latency.
    if (!multi) form.append('language', lang === 'es' ? 'es' : 'en');
    // verbose_json is where a detected language can come back; it is not promised,
    // so the caller falls back to null (lib/langid.js decides from the text itself).
    form.append('response_format', multi ? 'verbose_json' : 'json');

    let failure = null;
    let retryAfterMs = null;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: withTimeout(signal),
      });
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      failure = new Error(`[groq] No se pudo contactar con Groq: ${redact(err?.message || String(err))}`);
    }
    if (!failure && !res.ok) {
      const body = await res.text().catch(() => '');
      failure = new Error(statusMessage(res.status, body));
      if (!isRetryableStatus(res.status)) throw failure;
      retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'));
    }
    if (!failure) break;
    if (attempt >= RETRIES) throw failure;
    await sleep(retryDelayMs(attempt, retryAfterMs), signal);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`[groq] Respuesta de Groq inválida: ${redact(err?.message || String(err))}`);
  }
  const reported = typeof data.language === 'string' ? data.language.toLowerCase() : '';
  // Whisper names languages in English words ("spanish"), not codes.
  const detected = /^(es|spa|spanish|castilian|español)$/.test(reported) ? 'es'
    : /^(en|eng|english|inglés)$/.test(reported) ? 'en'
    : null;
  return { text: data.text || '', lang: detected };
}
