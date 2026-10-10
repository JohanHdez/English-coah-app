// Every AI the learner can choose, for each of the two jobs: transcription (the
// meeting's audio) and chat (translation and the coach — text only). Each adapter
// is a pure request builder and a response parser; callTranscribe/callChat add the
// key, the timeout and the retry policy, so all five providers fail, retry and
// redact identically. Pure: no DOM, no storage — runs under node --test.

import { floatToWav } from './lib/segmenter.js';

export const PROVIDERS = [
  {
    id: 'groq',
    label: 'Groq',
    jobs: ['transcribe', 'chat'],
    base: 'https://api.groq.com',
    keyHeader: 'Authorization',
    keyUrl: 'https://console.groq.com/keys',
    // https://console.groq.com/docs/models (both listed as production models, 2026-10-09)
    models: { transcribe: 'whisper-large-v3-turbo', chat: 'openai/gpt-oss-120b' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    jobs: ['transcribe', 'chat'],
    base: 'https://api.openai.com',
    keyHeader: 'Authorization',
    keyUrl: 'https://platform.openai.com/api-keys',
    // https://developers.openai.com/api/docs/models — gpt-4o-mini-transcribe is
    // announced for removal on 2027-02-26 (https://developers.openai.com/api/docs/deprecations).
    models: { transcribe: 'gpt-4o-mini-transcribe', chat: 'gpt-4.1-mini' },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    jobs: ['transcribe', 'chat'],
    base: 'https://generativelanguage.googleapis.com',
    keyHeader: 'x-goog-api-key',
    keyUrl: 'https://aistudio.google.com/apikey',
    // https://ai.google.dev/gemini-api/docs/models: the 2.5 models are served only to
    // projects that already used them, so a new key would be refused gemini-2.5-flash.
    models: { transcribe: 'gemini-3.8-flash', chat: 'gemini-3.8-flash' },
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    jobs: ['chat'],
    base: 'https://api.anthropic.com',
    keyHeader: 'x-api-key',
    keyUrl: 'https://platform.claude.com/',
    // https://platform.claude.com/docs/en/about-claude/model-deprecations:
    // claude-haiku-4-5-20251001 may retire from 2026-10-15; claude-haiku-5-5 not before 2027-10-07.
    models: { chat: 'claude-haiku-5-5' },
  },
  {
    id: 'local',
    label: 'Servidor local',
    jobs: ['transcribe', 'chat'],
    base: null,
    keyHeader: 'Authorization',
    keyUrl: null,
    models: {},
  },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;
export const providersFor = (job) => PROVIDERS.filter((p) => p.jobs.includes(job));

const DEFAULT_PROVIDER = 'groq';

// --- Settings -------------------------------------------------------------------

export function defaultSettings() {
  return {
    transcribeProvider: DEFAULT_PROVIDER,
    chatProvider: DEFAULT_PROVIDER,
    keys: Object.fromEntries(PROVIDERS.map((p) => [p.id, ''])),
    models: {},
    localBase: '',
    lang: 'en',
    translate: true,
  };
}

// Phase 1 stored `{ groqKey, groqBase, lang, translate }`. groqBase is the
// harness's stand-in address and keeps its name.
export function migrateSettings(stored) {
  const raw = { ...(stored || {}) };
  const out = { ...defaultSettings(), ...raw };
  out.keys = { ...defaultSettings().keys, ...(raw.keys || {}) };
  if (raw.groqKey && !out.keys.groq) out.keys.groq = raw.groqKey;
  delete out.groqKey;
  out.models = { ...(raw.models || {}) };
  if (!providerById(out.transcribeProvider)?.jobs.includes('transcribe')) out.transcribeProvider = DEFAULT_PROVIDER;
  if (!providerById(out.chatProvider)?.jobs.includes('chat')) out.chatProvider = DEFAULT_PROVIDER;
  return out;
}

export function modelFor(settings, id, job) {
  return (settings.models?.[id]?.[job] || '').trim() || providerById(id)?.models[job] || '';
}

// A custom endpoint may only be this device: audio and keys never go to a host the
// CSP does not already name.
export function isLocalBase(base) {
  if (!base || typeof base !== 'string') return false;
  let url;
  try { url = new URL(base); } catch { return false; }
  // http only: the CSP's connect-src names http://localhost:* and
  // http://127.0.0.1:*, so an https loopback base would fail with a generic error.
  if (url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

// The harness points a provider at its loopback stand-in; anything that is not
// loopback is ignored, so a stored override can never carry a key elsewhere.
function baseFor(settings, id) {
  if (id === 'local') return settings.localBase;
  const override = id === 'groq' ? settings.groqBase || settings.bases?.groq : settings.bases?.[id];
  return isLocalBase(override) ? override : providerById(id).base;
}

function missing(settings, id, job) {
  const p = providerById(id);
  if (!p || !p.jobs.includes(job)) return 'provider';
  if (id === 'local') {
    if (!isLocalBase(settings.localBase)) return 'base';
    if (!modelFor(settings, id, job)) return 'model';
    return null;
  }
  return settings.keys?.[id] ? null : 'key';
}

export const isConfigured = (settings) => missing(settings, settings.transcribeProvider, 'transcribe') === null;
export const isChatConfigured = (settings) => missing(settings, settings.chatProvider, 'chat') === null;

const LOCAL_ROUTE = 'tu servidor local (no sale de este dispositivo)';

// For the privacy screen and settings: who receives what, for the current choice.
export function routing(settings) {
  const name = (id) => (id === 'local' ? LOCAL_ROUTE : providerById(id)?.label || id);
  return {
    audio: `El audio de la reunión se envía a ${name(settings.transcribeProvider)} para transcribirse.`,
    text: settings.translate === false
      ? `El texto de la conversación solo se envía a ${name(settings.chatProvider)} cuando pides al coach una «Respuesta» o el informe.`
      : `El texto de la conversación se envía a ${name(settings.chatProvider)} para la traducción (cuando el navegador no traduce por sí mismo) y el coach.`,
  };
}

// --- Request adapters ---------------------------------------------------------------

const trimBase = (base) => String(base).replace(/\/+$/, '');

function localBaseOrThrow(base, stage) {
  if (!isLocalBase(base)) throw new Error(`${stage} El servidor local debe estar en http://localhost o http://127.0.0.1.`);
  return trimBase(base);
}

function bytesOf(audioWav) {
  return audioWav instanceof Uint8Array ? audioWav : new Uint8Array(audioWav);
}

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const LANG_NAME = { en: 'English', es: 'Spanish' };

export function buildTranscribe(id, { audioWav, model, lang = 'en', base }) {
  const stage = '[transcripción]';
  if (id === 'anthropic') throw new Error(`${stage} Claude no recibe audio: elige otro proveedor para la transcripción.`);
  const p = providerById(id);
  if (!p || !p.jobs.includes('transcribe')) throw new Error(`${stage} Proveedor desconocido: ${id}.`);
  const multi = lang === 'multi';
  const bytes = bytesOf(audioWav);

  if (id === 'gemini') {
    // https://ai.google.dev/api/generate-content (POST v1beta/models/{model}:generateContent,
    // Part.inlineData) and https://ai.google.dev/gemini-api/docs/audio (audio/wav is
    // a supported type). The key travels in x-goog-api-key, never in `?key=`.
    const hint = multi ? '' : ` The audio is in ${LANG_NAME[lang] || 'English'}.`;
    return {
      url: `${trimBase(base || p.base)}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: `Transcribe this audio verbatim; reply with the transcript only.${hint} If nothing is said, reply with nothing.` },
              { inlineData: { mimeType: 'audio/wav', data: base64(bytes) } },
            ],
          }],
        }),
      },
    };
  }

  // Groq: https://console.groq.com/docs/speech-to-text (POST /openai/v1/audio/transcriptions).
  // OpenAI: https://developers.openai.com/api/docs/guides/speech-to-text — the
  // gpt-4o-*-transcribe models answer json only (text, languages); verbose_json is
  // whisper-1's, and gpt-transcribe takes `languages` instead of `language`.
  // local: any server that implements OpenAI's path (speaches, whisper.cpp server…).
  const url = id === 'groq' ? `${trimBase(base || p.base)}/openai/v1/audio/transcriptions`
    : id === 'local' ? `${localBaseOrThrow(base, stage)}/v1/audio/transcriptions`
    : `${trimBase(base || p.base)}/v1/audio/transcriptions`;
  const verbose = id !== 'openai' || /^whisper/.test(model);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  // In a bilingual meeting the language is the question, not an input: omitting it
  // is what makes the model detect it. A single-language session pins it.
  if (!multi && !(id === 'openai' && /^gpt-transcribe/.test(model))) form.append('language', lang === 'es' ? 'es' : 'en');
  form.append('response_format', multi && verbose ? 'verbose_json' : 'json');
  return { url, init: { method: 'POST', headers: {}, body: form } };
}

// Whisper names languages in English words ("spanish"); OpenAI's newer models
// return ISO codes in `languages`.
function langCode(reported) {
  const r = typeof reported === 'string' ? reported.toLowerCase() : '';
  if (/^(es|spa|spanish|castilian|español)$/.test(r)) return 'es';
  if (/^(en|eng|english|inglés)$/.test(r)) return 'en';
  return null;
}

const geminiText = (json) => (json?.candidates?.[0]?.content?.parts || [])
  .map((part) => (typeof part.text === 'string' && !part.thought ? part.text : ''))
  .join('')
  .trim();

// https://ai.google.dev/api/generate-content#FinishReason: a prompt blocked
// outright has no candidates, a reply stopped by a filter has another
// finishReason. Either way the segment's words are gone, which the screen says.
function geminiTranscript(json) {
  const candidate = json?.candidates?.[0];
  const text = geminiText(json);
  const reason = candidate ? candidate.finishReason : json?.promptFeedback?.blockReason || 'sin respuesta';
  const truncated = reason === 'MAX_TOKENS' && text;
  if (!candidate || (reason && reason !== 'STOP' && reason !== 'FINISH_REASON_UNSPECIFIED' && !truncated)) {
    throw new Error(`[transcripción] Gemini bloqueó este fragmento (${reason}); sus palabras se perdieron.`);
  }
  return text;
}

export function parseTranscribe(id, json) {
  if (id === 'gemini') return { text: geminiTranscript(json), lang: null };
  const reported = typeof json?.language === 'string' ? json.language
    : Array.isArray(json?.languages) ? json.languages[0] : null;
  return { text: typeof json?.text === 'string' ? json.text.trim() : '', lang: langCode(reported) };
}

const DEFAULT_MAX_TOKENS = 1024;

export function buildChat(id, { system, user, model, maxTokens, schema, base, stage = '[coach]' }) {
  const p = providerById(id);
  if (!p || !p.jobs.includes('chat')) throw new Error(`${stage} Proveedor desconocido: ${id}.`);
  const json = { 'Content-Type': 'application/json' };

  if (id === 'anthropic') {
    // https://platform.claude.com/docs/en/api/messages (POST /v1/messages,
    // anthropic-version, output_config.format for a JSON schema). A browser call is
    // refused by CORS unless anthropic-dangerous-direct-browser-access is set; the
    // key it exposes is the learner's own, on the learner's own device. temperature
    // is not sent: Claude 4.7 and later answer 400 to a non-default value.
    const body = {
      model,
      max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    };
    if (schema) body.output_config = { format: { type: 'json_schema', schema } };
    return {
      url: `${trimBase(base || p.base)}/v1/messages`,
      init: {
        method: 'POST',
        headers: { ...json, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify(body),
      },
    };
  }

  if (id === 'gemini') {
    // https://ai.google.dev/api/generate-content (systemInstruction,
    // generationConfig.maxOutputTokens / responseMimeType / responseJsonSchema).
    const generationConfig = {};
    if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
    if (schema) { generationConfig.responseMimeType = 'application/json'; generationConfig.responseJsonSchema = schema; }
    const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    return {
      url: `${trimBase(base || p.base)}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: { method: 'POST', headers: json, body: JSON.stringify(body) },
    };
  }

  // OpenAI: https://platform.openai.com/docs/api-reference/chat/create; Groq:
  // https://console.groq.com/docs/api-reference (max_tokens deprecated there in favour
  // of max_completion_tokens). Local servers (Ollama, llama.cpp) know max_tokens.
  const url = id === 'groq' ? `${trimBase(base || p.base)}/openai/v1/chat/completions`
    : id === 'local' ? `${localBaseOrThrow(base, stage)}/v1/chat/completions`
    : `${trimBase(base || p.base)}/v1/chat/completions`;
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (maxTokens) body[id === 'local' ? 'max_tokens' : 'max_completion_tokens'] = maxTokens;
  if (schema) {
    const json_schema = { name: 'reply', schema };
    // Strict is constrained decoding, the one mode that cannot return invalid JSON; a local server may not know it.
    if (id !== 'local') json_schema.strict = true;
    body.response_format = { type: 'json_schema', json_schema };
  }
  return { url, init: { method: 'POST', headers: json, body: JSON.stringify(body) } };
}

export function parseChat(id, json) {
  if (id === 'anthropic') {
    return (json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }
  if (id === 'gemini') return geminiText(json);
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

function authHeaders(id, key) {
  if (!key) return {};
  const header = providerById(id).keyHeader;
  return { [header]: header === 'Authorization' ? `Bearer ${key}` : key };
}

// --- The HTTP policy (Phase 1's, now shared by every provider) ------------------------

// A stalled request (a dead mobile connection mid-upload) must not hang
// session.drain() forever — AbortSignal.timeout turns it into an ordinary fetch
// rejection, caught and staged exactly like any other network failure.
export const TIMEOUT_MS = 30000;

// Two retries after the first attempt. The free tiers answer 429 when a lively
// meeting outruns their per-minute cap; a few seconds later the same request
// succeeds, and the words would otherwise be lost for good.
export const RETRIES = 2;
const BACKOFF_BASE_MS = 1000;
// A Retry-After longer than this is not worth honouring mid-meeting: the session
// queue keeps filling behind the wait, and the bubble would land too late to read.
export const MAX_WAIT_MS = 8000;

// Error bodies can echo the request back, and a misbehaving proxy could put a
// header's value in one. Groq gsk_, OpenAI/Anthropic sk-, xAI xai-, Google AIza.
const KEY_SHAPED = /(gsk_[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|xai-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{6,})/g;
const HIDDEN = '«API key oculta»';
// A literal key shorter than this is not redacted by value: a one-to-seven
// character local key ("abc") would cut words out of every message, and it is too
// short to be a secret worth hiding from the learner's own screen.
const MIN_LITERAL_KEY = 8;
export function redact(text, keys = []) {
  let out = String(text ?? '');
  for (const key of keys) if (key && key.length >= MIN_LITERAL_KEY) out = out.split(key).join(HIDDEN);
  return out.replace(KEY_SHAPED, HIDDEN);
}

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

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (AbortSignal.any) return AbortSignal.any([signal, timeout]);
  // Safari before 17.4 has no AbortSignal.any.
  const both = new AbortController();
  for (const s of [signal, timeout]) s.addEventListener('abort', () => both.abort(s.reason), { once: true });
  return both.signal;
}

function statusMessage({ stage, label, status, body, keys, lost }) {
  if (status === 401 || status === 403) return `${stage} Clave de ${label} no válida.`;
  if (status === 429) return `${stage} ${label} está limitando las peticiones (429)${lost ? '; se perdió un fragmento.' : '. Espera un minuto y vuelve a intentarlo.'}`;
  return `${stage} ${label} ${status}: ${redact(body, keys).slice(0, 200)}`;
}

// `signal` belongs to the caller: for transcription it fires when the meeting is
// finished, and nothing may be uploaded or retried after that.
async function send({ id, key, build, stage, signal, sleep = waitFor, retries = RETRIES, timeoutMs = TIMEOUT_MS, lost = false }) {
  const { label } = providerById(id);
  const keys = [key];
  let res;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    // Rebuilt on each attempt: a FormData body is consumed by the first fetch.
    const { url, init } = build();
    let failure = null;
    let retryAfterMs = null;
    try {
      res = await fetch(url, { ...init, headers: { ...init.headers, ...authHeaders(id, key) }, signal: withTimeout(signal, timeoutMs) });
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      failure = stage === '[coach]'
        ? new Error(`${stage} Sin conexión con ${label}. Revisa tu red y vuelve a intentarlo.`)
        : new Error(`${stage} No se pudo contactar con ${label}: ${redact(err?.message || String(err), keys)}`);
    }
    if (!failure && !res.ok) {
      const body = await res.text().catch(() => '');
      failure = new Error(statusMessage({ stage, label, status: res.status, body, keys, lost }));
      if (!isRetryableStatus(res.status)) throw failure;
      retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'));
    }
    if (!failure) break;
    if (attempt >= retries) throw failure;
    await sleep(retryDelayMs(attempt, retryAfterMs), signal);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${stage} Respuesta de ${label} inválida: ${redact(err?.message || String(err), keys)}`);
  }
}

function precheck(settings, id, job, stage) {
  if (job === 'transcribe' && id === 'anthropic') throw new Error(`${stage} Claude no recibe audio: elige otro proveedor para la transcripción.`);
  const why = missing(settings, id, job);
  const label = providerById(id)?.label || id;
  if (why === 'provider') throw new Error(`${stage} Proveedor desconocido: ${id}.`);
  if (why === 'key') throw new Error(`${stage} Falta la API key de ${label}${job === 'chat' ? ' (ábrela en Ajustes)' : ''}.`);
  if (why === 'base') throw new Error(`${stage} El servidor local debe estar en http://localhost o http://127.0.0.1.`);
  if (why === 'model') throw new Error(`${stage} Falta el modelo del servidor local.`);
}

export async function callTranscribe(settings, samples, { signal, sleep } = {}) {
  const stage = '[transcripción]';
  const id = settings.transcribeProvider || DEFAULT_PROVIDER;
  precheck(settings, id, 'transcribe', stage);
  if (signal?.aborted) throw abortError(signal);
  const audioWav = new Uint8Array(await floatToWav(samples).arrayBuffer());
  const model = modelFor(settings, id, 'transcribe');
  const base = baseFor(settings, id);
  const json = await send({
    id,
    key: settings.keys?.[id] || '',
    build: () => buildTranscribe(id, { audioWav, model, lang: settings.lang || 'en', base }),
    stage,
    signal,
    sleep,
    lost: true,
  });
  return parseTranscribe(id, json);
}

export async function callChat(settings, { system, user, maxTokens, schema, signal, sleep, stage = '[coach]', retries, timeoutMs }) {
  const id = settings.chatProvider || DEFAULT_PROVIDER;
  precheck(settings, id, 'chat', stage);
  const model = modelFor(settings, id, 'chat');
  const base = baseFor(settings, id);
  const json = await send({
    id,
    key: settings.keys?.[id] || '',
    build: () => buildChat(id, { system, user, model, maxTokens, schema, base, stage }),
    stage,
    signal,
    sleep,
    retries,
    timeoutMs,
  });
  return parseChat(id, json);
}
