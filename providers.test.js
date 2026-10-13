import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROVIDERS, providerById, isLocalBase, defaultSettings, migrateSettings, isConfigured, routing,
  buildTranscribe, parseTranscribe, buildChat, parseChat, callTranscribe, callChat, redact,
} from './providers.js';

const noWait = async () => {};
const samples = Float32Array.from({ length: 160 }, (_, i) => Math.sin(i / 5) / 2);
const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 250, 251, 252]);

const KEYS = {
  groq: 'gsk_groq_secret_000000',
  openai: 'sk-openai_secret_000000',
  gemini: 'AIzaGeminiSecret0000000000000000',
  anthropic: 'sk-ant-anthropic_secret_0000',
  local: 'plain-local-secret',
};

function settingsFor(transcribeProvider, chatProvider = transcribeProvider, extra = {}) {
  return migrateSettings({ transcribeProvider, chatProvider, keys: { ...KEYS }, localBase: 'http://localhost:8000', models: { local: { transcribe: 'whisper-small', chat: 'llama3.2' } }, ...extra });
}

// Records every fetch and answers with `respond(url, init, n)`.
function stubFetch(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const okJson = (json) => ({ ok: true, status: 200, headers: new Headers(), json: async () => json, text: async () => JSON.stringify(json) });
const failing = (status, body) => ({ ok: false, status, headers: new Headers(), json: async () => ({}), text: async () => body });

async function bodyText(init) {
  if (typeof init.body === 'string') return init.body;
  if (init.body instanceof FormData) {
    const parts = [];
    for (const [name, value] of init.body) parts.push(`${name}=${typeof value === 'string' ? value : await value.text()}`);
    return parts.join('&');
  }
  return String(init.body ?? '');
}

function headerEntries(init) {
  return Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]);
}

// --- The catalogue ----------------------------------------------------------

test('five providers; Claude does chat only; the documented default models', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['groq', 'openai', 'gemini', 'anthropic', 'local']);
  assert.deepEqual(providerById('anthropic').jobs, ['chat']);
  for (const id of ['groq', 'openai', 'gemini', 'local']) assert.deepEqual(providerById(id).jobs, ['transcribe', 'chat']);
  assert.equal(providerById('groq').models.transcribe, 'whisper-large-v3-turbo');
  assert.equal(providerById('groq').models.chat, 'openai/gpt-oss-120b');
  assert.equal(providerById('openai').models.transcribe, 'gpt-4o-mini-transcribe');
  assert.equal(providerById('openai').models.chat, 'gpt-4.1-mini');
  assert.equal(providerById('gemini').models.transcribe, 'gemini-3.8-flash');
  assert.equal(providerById('gemini').models.chat, 'gemini-3.8-flash');
  assert.equal(providerById('anthropic').models.chat, 'claude-haiku-5-5');
  assert.equal(providerById('nope'), null);
});

test('the CSP connect-src lists exactly the providers\' hosts, loopback, and the model hosts', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const csp = /content="([^"]*connect-src[^"]*)"/.exec(html)[1];
  const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')).split(/\s+/).slice(1);
  assert.ok(!connect.includes('https:') && !connect.includes('http:') && !connect.includes('*'), 'no wildcard scheme');
  const remote = PROVIDERS.filter((p) => p.base).map((p) => p.base);
  for (const host of remote) assert.ok(connect.includes(host), `${host} missing from connect-src`);
  for (const loop of ['http://localhost:*', 'http://127.0.0.1:*']) assert.ok(connect.includes(loop), `${loop} missing`);
  const modelHosts = connect.filter((h) => /huggingface\.co|hf\.co/.test(h));
  const rest = connect.filter((h) => h !== "'self'" && !remote.includes(h) && !modelHosts.includes(h) && !/^http:\/\/(localhost|127\.0\.0\.1):\*$/.test(h));
  assert.deepEqual(rest, [], 'nothing else may receive a connection');
});

test('isLocalBase accepts only localhost and 127.0.0.1', () => {
  for (const ok of ['http://localhost:8000', 'http://127.0.0.1:11434/', 'http://localhost']) assert.ok(isLocalBase(ok), ok);
  // The CSP allows loopback over http only; https would pass here and fail in fetch.
  for (const csp of ['https://localhost:9000', 'https://127.0.0.1']) assert.equal(isLocalBase(csp), false, csp);
  for (const bad of ['https://evil.example', 'http://192.168.1.2:8000', 'http://localhost.evil.com', 'http://127.0.0.1.nip.io', 'ftp://localhost', '', null, 'not a url', 'http://user@evil.example#@localhost']) {
    assert.equal(isLocalBase(bad), false, String(bad));
  }
});

// --- Settings ---------------------------------------------------------------

test('Phase 1 settings migrate: groqKey moves into keys, groqBase stays as the override', () => {
  const out = migrateSettings({ groqKey: 'gsk_old', groqBase: 'http://127.0.0.1:9', lang: 'multi', translate: false });
  assert.equal(out.keys.groq, 'gsk_old');
  assert.equal('groqKey' in out, false);
  assert.equal(out.groqBase, 'http://127.0.0.1:9');
  assert.equal(out.transcribeProvider, 'groq');
  assert.equal(out.chatProvider, 'groq');
  assert.equal(out.lang, 'multi');
  assert.equal(out.translate, false);
  assert.deepEqual(Object.keys(out.keys).sort(), ['anthropic', 'gemini', 'groq', 'local', 'openai']);
  assert.deepEqual(migrateSettings(out), out, 'idempotent');
  assert.deepEqual(migrateSettings(undefined), defaultSettings());
});

test('a key already in the new shape wins over a stale groqKey', () => {
  const out = migrateSettings({ groqKey: 'gsk_old', keys: { groq: 'gsk_new' } });
  assert.equal(out.keys.groq, 'gsk_new');
});

test('Claude saved as the transcription provider falls back to Groq', () => {
  assert.equal(migrateSettings({ transcribeProvider: 'anthropic' }).transcribeProvider, 'groq');
  assert.equal(migrateSettings({ chatProvider: 'bogus' }).chatProvider, 'groq');
});

test('isConfigured asks for what the transcription provider needs', () => {
  assert.equal(isConfigured(migrateSettings({})), false);
  assert.equal(isConfigured(migrateSettings({ groqKey: 'gsk_x' })), true);
  assert.equal(isConfigured(migrateSettings({ transcribeProvider: 'openai', keys: { groq: 'gsk_x' } })), false);
  assert.equal(isConfigured(migrateSettings({ transcribeProvider: 'local', localBase: 'http://localhost:8000', models: { local: { transcribe: 'w' } } })), true);
  assert.equal(isConfigured(migrateSettings({ transcribeProvider: 'local', localBase: 'https://evil.example', models: { local: { transcribe: 'w' } } })), false);
  assert.equal(isConfigured(migrateSettings({ transcribeProvider: 'local', localBase: 'http://localhost:8000' })), false, 'a local model has no default');
});

test('routing names who receives the audio and who receives text', () => {
  const r = routing(migrateSettings({ transcribeProvider: 'gemini', chatProvider: 'anthropic' }));
  assert.match(r.audio, /Google Gemini/);
  assert.match(r.text, /Anthropic Claude/);
  const local = routing(migrateSettings({ transcribeProvider: 'local', chatProvider: 'local' }));
  assert.match(local.audio, /servidor local/);
  assert.match(local.audio, /no sale de/);
});

test('routing does not claim conversation text is sent for translation when translation is off', () => {
  const on = routing(migrateSettings({ transcribeProvider: 'groq', chatProvider: 'groq', translate: true }));
  assert.match(on.text, /para la traducción/);
  const off = routing(migrateSettings({ transcribeProvider: 'groq', chatProvider: 'groq', translate: false }));
  assert.doesNotMatch(off.text, /traducción/);
  assert.match(off.text, /solo se envía a Groq cuando pides/);
});

// --- Transcription adapters ---------------------------------------------------

test('Groq transcription: its OpenAI-compatible path, language pinned, plain json', async () => {
  const { url, init } = buildTranscribe('groq', { audioWav: wav, model: 'whisper-large-v3-turbo', lang: 'en' });
  assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(init.method, 'POST');
  assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
  assert.equal(init.body.get('language'), 'en');
  assert.equal(init.body.get('response_format'), 'json');
  assert.equal(init.body.get('file').type, 'audio/wav');
  assert.deepEqual(new Uint8Array(await init.body.get('file').arrayBuffer()), wav);
  const multi = buildTranscribe('groq', { audioWav: wav, model: 'm', lang: 'multi' });
  assert.equal(multi.init.body.has('language'), false);
  assert.equal(multi.init.body.get('response_format'), 'verbose_json');
  assert.deepEqual(parseTranscribe('groq', { text: 'Hola.', language: 'spanish' }), { text: 'Hola.', lang: 'es' });
  assert.deepEqual(parseTranscribe('groq', { text: 'Hi.', language: 'french' }), { text: 'Hi.', lang: null });
});

test('OpenAI transcription: json only (gpt-4o-*-transcribe has no verbose_json), languages[] read back', () => {
  const { url, init } = buildTranscribe('openai', { audioWav: wav, model: 'gpt-4o-mini-transcribe', lang: 'es' });
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(init.body.get('language'), 'es');
  assert.equal(init.body.get('response_format'), 'json');
  const multi = buildTranscribe('openai', { audioWav: wav, model: 'gpt-4o-mini-transcribe', lang: 'multi' });
  assert.equal(multi.init.body.has('language'), false);
  assert.equal(multi.init.body.get('response_format'), 'json');
  const whisper = buildTranscribe('openai', { audioWav: wav, model: 'whisper-1', lang: 'multi' });
  assert.equal(whisper.init.body.get('response_format'), 'verbose_json');
  assert.deepEqual(parseTranscribe('openai', { text: 'Hola', languages: ['es'] }), { text: 'Hola', lang: 'es' });
  assert.deepEqual(parseTranscribe('openai', { text: 'Hi' }), { text: 'Hi', lang: null });
});

test('Gemini transcription: generateContent with the WAV inline as base64, no key anywhere in it', () => {
  const { url, init } = buildTranscribe('gemini', { audioWav: wav, model: 'gemini-3.8-flash', lang: 'en' });
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(init.body);
  const parts = body.contents[0].parts;
  const audio = parts.find((p) => p.inlineData);
  assert.equal(audio.inlineData.mimeType, 'audio/wav');
  assert.equal(audio.inlineData.data, Buffer.from(wav).toString('base64'));
  const prompt = parts.find((p) => p.text).text;
  assert.match(prompt, /Transcribe this audio verbatim; reply with the transcript only/);
  assert.match(prompt, /English/);
  const multi = JSON.parse(buildTranscribe('gemini', { audioWav: wav, model: 'g', lang: 'multi' }).init.body);
  assert.doesNotMatch(multi.contents[0].parts.find((p) => p.text).text, /English|Spanish/);
  assert.deepEqual(
    parseTranscribe('gemini', { candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'there.\n' }] } }] }),
    { text: 'Hello there.', lang: null },
  );
  assert.deepEqual(parseTranscribe('gemini', { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] }), { text: '', lang: null });
});

test('a blocked Gemini transcription is a staged Spanish error, not empty text', () => {
  assert.throws(() => parseTranscribe('gemini', { candidates: [] }), /^Error: \[transcripción\] Gemini bloqueó este fragmento \(sin respuesta\)/);
  assert.throws(() => parseTranscribe('gemini', { promptFeedback: { blockReason: 'SAFETY' } }), /^Error: \[transcripción\] Gemini bloqueó este fragmento \(SAFETY\)/);
  assert.throws(() => parseTranscribe('gemini', { candidates: [{ finishReason: 'RECITATION' }] }), /\(RECITATION\)/);
  assert.throws(() => parseTranscribe('gemini', { candidates: [{ content: { parts: [{ text: 'half' }] }, finishReason: 'SAFETY' }] }), /\(SAFETY\)/);
  assert.deepEqual(parseTranscribe('gemini', { candidates: [{ content: { parts: [{ text: 'cut short' }] }, finishReason: 'MAX_TOKENS' }] }), { text: 'cut short', lang: null });
  assert.throws(() => parseTranscribe('gemini', { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }), /\(MAX_TOKENS\)/);
});

test('Claude is refused for transcription', () => {
  assert.throws(() => buildTranscribe('anthropic', { audioWav: wav, model: 'x', lang: 'en' }), /\[transcripción\] Claude no recibe audio/);
});

test('the local provider speaks OpenAI\'s shape, but only to localhost', () => {
  const { url, init } = buildTranscribe('local', { audioWav: wav, model: 'whisper-small', lang: 'multi', base: 'http://localhost:8000/' });
  assert.equal(url, 'http://localhost:8000/v1/audio/transcriptions');
  assert.equal(init.body.get('response_format'), 'verbose_json');
  for (const base of ['https://api.example.com', 'http://10.0.0.2:8000', undefined]) {
    assert.throws(() => buildTranscribe('local', { audioWav: wav, model: 'w', lang: 'en', base }), /\[transcripción\].*localhost/, String(base));
    assert.throws(() => buildChat('local', { system: 's', user: 'u', model: 'm', base }), /localhost/, String(base));
  }
});

// --- Chat adapters -------------------------------------------------------------

test('OpenAI-compatible chat (Groq, OpenAI, local)', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const cases = [
    ['groq', 'https://api.groq.com/openai/v1/chat/completions', 'max_completion_tokens', undefined],
    ['openai', 'https://api.openai.com/v1/chat/completions', 'max_completion_tokens', undefined],
    ['local', 'http://127.0.0.1:11434/v1/chat/completions', 'max_tokens', 'http://127.0.0.1:11434'],
  ];
  for (const [id, expected, tokensField, base] of cases) {
    const { url, init } = buildChat(id, { system: 'Be brief.', user: 'Hello', model: 'm1', maxTokens: 300, schema, base });
    assert.equal(url, expected, id);
    assert.equal(init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'm1');
    assert.deepEqual(body.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }]);
    assert.equal(body[tokensField], 300, id);
    assert.equal(body.response_format.type, 'json_schema');
    assert.deepEqual(body.response_format.json_schema.schema, schema);
    assert.ok(body.response_format.json_schema.name);
    assert.equal(body.response_format.json_schema.strict, id === 'local' ? undefined : true);
    const plain = JSON.parse(buildChat(id, { system: 's', user: 'u', model: 'm', base }).init.body);
    assert.equal('response_format' in plain, false);
    assert.equal(parseChat(id, { choices: [{ message: { content: ' Hola ' } }] }), 'Hola');
    assert.equal(parseChat(id, {}), '');
  }
});

test('Groq gpt-oss reasons at low effort; other models and providers are left alone', () => {
  const effort = (id, model) => JSON.parse(buildChat(id, { system: 's', user: 'u', model, base: id === 'local' ? 'http://127.0.0.1:11434' : undefined }).init.body).reasoning_effort;
  assert.equal(effort('groq', 'openai/gpt-oss-120b'), 'low');
  assert.equal(effort('groq', 'llama-3.3-70b-versatile'), undefined);
  assert.equal(effort('openai', 'openai/gpt-oss-120b'), undefined);
  assert.equal(effort('local', 'openai/gpt-oss-120b'), undefined);
});

test('Anthropic chat: /v1/messages, the version and browser-access headers, no temperature', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const { url, init } = buildChat('anthropic', { system: 'Be brief.', user: 'Hello', model: 'claude-haiku-5-5', maxTokens: 200, schema });
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.system, 'Be brief.');
  assert.equal(body.max_tokens, 200);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hello' }]);
  assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema } });
  assert.equal('temperature' in body, false);
  assert.ok(JSON.parse(buildChat('anthropic', { system: 's', user: 'u', model: 'm' }).init.body).max_tokens > 0, 'max_tokens is required by the API');
  assert.equal(parseChat('anthropic', { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Hola' }, { type: 'text', text: ' amigo' }] }), 'Hola amigo');
});

test('Gemini chat: generateContent with systemInstruction and a JSON schema', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const { url, init } = buildChat('gemini', { system: 'Be brief.', user: 'Hello', model: 'gemini-3.8-flash', maxTokens: 100, schema });
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  const body = JSON.parse(init.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be brief.' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Hello' }] }]);
  assert.equal(body.generationConfig.maxOutputTokens, 100);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseJsonSchema, schema);
  assert.equal(parseChat('gemini', { candidates: [{ content: { parts: [{ text: 'Hola' }] } }] }), 'Hola');
});

// --- Calls: keys, hosts, errors ---------------------------------------------------

const TRANSCRIBE_REPLY = {
  groq: { text: 'hi' },
  openai: { text: 'hi' },
  local: { text: 'hi' },
  gemini: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
};

test('each transcription call sends its key only in its own header, to its own host', async () => {
  const expected = {
    groq: ['authorization', `Bearer ${KEYS.groq}`, 'https://api.groq.com/'],
    openai: ['authorization', `Bearer ${KEYS.openai}`, 'https://api.openai.com/'],
    gemini: ['x-goog-api-key', KEYS.gemini, 'https://generativelanguage.googleapis.com/'],
    local: ['authorization', `Bearer ${KEYS.local}`, 'http://localhost:8000/'],
  };
  for (const [id, [header, value, host]] of Object.entries(expected)) {
    const { calls, restore } = stubFetch(() => okJson(TRANSCRIBE_REPLY[id]));
    try {
      const out = await callTranscribe(settingsFor(id), samples, {});
      assert.equal(out.text, 'hi', id);
      const [{ url, init }] = calls;
      assert.ok(url.startsWith(host), `${id}: ${url}`);
      const key = KEYS[id];
      assert.ok(!url.includes(key), `${id}: key in the URL`);
      assert.ok(!(await bodyText(init)).includes(key), `${id}: key in the body`);
      const carrying = headerEntries(init).filter(([, v]) => String(v).includes(key));
      assert.deepEqual(carrying, [[header, value]], id);
      for (const other of Object.values(KEYS)) if (other !== key) assert.ok(!JSON.stringify(init.headers).includes(other), `${id} leaks another key`);
      assert.ok(init.signal instanceof AbortSignal, 'a timeout signal is always attached');
    } finally {
      restore();
    }
  }
});

test('each chat call sends its key only in its own header', async () => {
  const replies = {
    groq: { choices: [{ message: { content: 'ok' } }] },
    openai: { choices: [{ message: { content: 'ok' } }] },
    local: { choices: [{ message: { content: 'ok' } }] },
    gemini: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
    anthropic: { content: [{ type: 'text', text: 'ok' }] },
  };
  const header = { groq: 'authorization', openai: 'authorization', local: 'authorization', gemini: 'x-goog-api-key', anthropic: 'x-api-key' };
  for (const id of Object.keys(replies)) {
    const { calls, restore } = stubFetch(() => okJson(replies[id]));
    try {
      assert.equal(await callChat(settingsFor('groq', id), { system: 's', user: 'u' }), 'ok', id);
      const [{ url, init }] = calls;
      assert.ok(!url.includes(KEYS[id]));
      assert.ok(!(await bodyText(init)).includes(KEYS[id]));
      assert.deepEqual(headerEntries(init).filter(([, v]) => String(v).includes(KEYS[id])).map(([k]) => k), [header[id]], id);
    } finally {
      restore();
    }
  }
});

test('the local provider sends no Authorization header when it has no key', async () => {
  const { calls, restore } = stubFetch(() => okJson({ text: 'hi' }));
  try {
    const s = settingsFor('local');
    s.keys.local = '';
    await callTranscribe(s, samples, {});
    assert.equal(headerEntries(calls[0].init).some(([k]) => k === 'authorization'), false);
  } finally {
    restore();
  }
});

test('a loopback override (the harness) is honoured; any other override is ignored', async () => {
  const { calls, restore } = stubFetch((url) => okJson(url.includes('generateContent') ? TRANSCRIBE_REPLY.gemini : TRANSCRIBE_REPLY.groq));
  try {
    await callTranscribe(settingsFor('groq', 'groq', { groqBase: 'http://127.0.0.1:4000/' }), samples, {});
    await callTranscribe(settingsFor('gemini', 'gemini', { bases: { gemini: 'http://127.0.0.1:4001' } }), samples, {});
    await callTranscribe(settingsFor('groq', 'groq', { groqBase: 'https://evil.example' }), samples, {});
    await callTranscribe(settingsFor('openai', 'openai', { bases: { openai: 'https://evil.example' } }), samples, {}).catch(() => {});
    assert.equal(calls[0].url, 'http://127.0.0.1:4000/openai/v1/audio/transcriptions');
    assert.equal(calls[1].url, 'http://127.0.0.1:4001/v1beta/models/gemini-3.8-flash:generateContent');
    assert.equal(calls[2].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(calls[3].url, 'https://api.openai.com/v1/audio/transcriptions');
  } finally {
    restore();
  }
});

test('the model set in settings replaces the default', async () => {
  const { calls, restore } = stubFetch(() => okJson({ choices: [{ message: { content: 'ok' } }] }));
  try {
    await callChat(settingsFor('groq', 'openai', { models: { openai: { chat: 'gpt-6-luna' } } }), { system: 's', user: 'u' });
    assert.equal(JSON.parse(calls[0].init.body).model, 'gpt-6-luna');
  } finally {
    restore();
  }
});

test('Claude as the transcription provider is refused before any request', async () => {
  const { calls, restore } = stubFetch(() => okJson({}));
  try {
    const s = settingsFor('groq');
    s.transcribeProvider = 'anthropic';
    await assert.rejects(() => callTranscribe(s, samples, {}), /\[transcripción\] Claude no recibe audio/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('a missing key fails before any request, naming the provider and the stage', async () => {
  const { calls, restore } = stubFetch(() => okJson({}));
  try {
    const s = settingsFor('openai', 'anthropic');
    s.keys = { ...s.keys, openai: '', anthropic: '' };
    await assert.rejects(() => callTranscribe(s, samples, {}), /^Error: \[transcripción\] Falta la API key de OpenAI\.$/);
    await assert.rejects(() => callChat(s, { system: 's', user: 'u' }), /^Error: \[coach\] Falta la API key de Anthropic Claude \(ábrela en Ajustes\)\.$/);
    await assert.rejects(() => callChat(s, { system: 's', user: 'u', stage: '[traducción]' }), /^Error: \[traducción\]/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('an error body that echoes any key is redacted, whatever the key looks like', async () => {
  for (const id of ['groq', 'openai', 'gemini', 'local']) {
    const { restore } = stubFetch(() => failing(400, `bad request with key ${KEYS[id]} and gsk_abcdef0123456789 and AIzaSyD-0123456789abcdefghij`));
    try {
      await assert.rejects(() => callTranscribe(settingsFor(id), samples, { sleep: noWait }), (err) => {
        assert.ok(err.message.startsWith('[transcripción] '), err.message);
        for (const k of [KEYS[id], 'gsk_abcdef0123456789', 'AIzaSyD-0123456789abcdefghij']) assert.ok(!err.message.includes(k), `${id}: ${err.message}`);
        assert.ok(err.message.includes('«API key oculta»'));
        return true;
      });
    } finally {
      restore();
    }
  }
  const { restore } = stubFetch(() => failing(500, `oops ${KEYS.anthropic}`));
  try {
    await assert.rejects(() => callChat(settingsFor('groq', 'anthropic'), { system: 's', user: 'u', sleep: noWait }), (err) => {
      assert.ok(err.message.startsWith('[coach] Anthropic Claude 500:'), err.message);
      assert.ok(!err.message.includes(KEYS.anthropic));
      return true;
    });
  } finally {
    restore();
  }
});

test('a coach network failure is plain Spanish without the browser\'s message', async () => {
  const { restore } = stubFetch(() => { throw new TypeError(`Failed to fetch ${KEYS.groq}`); });
  try {
    await assert.rejects(() => callChat(settingsFor('groq'), { system: 's', user: 'u', sleep: noWait }), /^Error: \[coach\] Sin conexión con Groq\. Revisa tu red y vuelve a intentarlo\.$/);
  } finally {
    restore();
  }
});

test('a network failure that names the key is redacted too', async () => {
  const { restore } = stubFetch(() => { throw new TypeError(`Failed to fetch ${KEYS.gemini}`); });
  try {
    await assert.rejects(() => callTranscribe(settingsFor('gemini'), samples, { sleep: noWait }), (err) => {
      assert.match(err.message, /^\[transcripción\] No se pudo contactar con Google Gemini/);
      assert.ok(!err.message.includes(KEYS.gemini));
      return true;
    });
  } finally {
    restore();
  }
});

test('401 and 429 read as plain Spanish, naming the provider', async () => {
  let stub = stubFetch(() => failing(401, 'nope'));
  try {
    await assert.rejects(() => callTranscribe(settingsFor('openai'), samples, { sleep: noWait }), /^Error: \[transcripción\] Clave de OpenAI no válida\.$/);
  } finally {
    stub.restore();
  }
  stub = stubFetch(() => failing(429, ''));
  try {
    await assert.rejects(() => callTranscribe(settingsFor('gemini'), samples, { sleep: noWait }), /\[transcripción\] Google Gemini está limitando las peticiones \(429\)/);
  } finally {
    stub.restore();
  }
});

test('a coach rate limit tells the learner to wait; a missing chat key points at Ajustes', async () => {
  const stub = stubFetch(() => failing(429, ''));
  try {
    await assert.rejects(
      () => callChat(settingsFor('groq'), { system: 's', user: 'u', sleep: noWait }),
      /^Error: \[coach\] Groq está limitando las peticiones \(429\)\. Espera un minuto y vuelve a intentarlo\.$/,
    );
  } finally {
    stub.restore();
  }
  await assert.rejects(
    () => callChat(settingsFor('groq', 'groq', { keys: {} }), { system: 's', user: 'u' }),
    /^Error: \[coach\] Falta la API key de Groq \(ábrela en Ajustes\)\.$/,
  );
});

test('the Phase 1 retry policy covers chat and every provider', async () => {
  for (const id of ['gemini', 'anthropic']) {
    const reply = id === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } : { content: [{ type: 'text', text: 'ok' }] };
    const { calls, restore } = stubFetch((url, init, n) => (n < 3 ? failing(n === 1 ? 429 : 503, '') : okJson(reply)));
    const waits = [];
    try {
      assert.equal(await callChat(settingsFor('groq', id), { system: 's', user: 'u', sleep: async (ms) => { waits.push(ms); } }), 'ok');
      assert.equal(calls.length, 3);
      assert.deepEqual(waits, [1000, 2000]);
    } finally {
      restore();
    }
  }
  const { calls, restore } = stubFetch(() => failing(400, 'bad'));
  try {
    await assert.rejects(() => callChat(settingsFor('groq', 'openai'), { system: 's', user: 'u', sleep: noWait }), /\[coach\] OpenAI 400: bad/);
    assert.equal(calls.length, 1, 'a 4xx other than 429 is not retried');
  } finally {
    restore();
  }
});

test('retries can be turned off for a call that is only nice to have', async () => {
  const { calls, restore } = stubFetch(() => failing(503, ''));
  try {
    await assert.rejects(() => callChat(settingsFor('groq'), { system: 's', user: 'u', retries: 0, stage: '[traducción]' }), /^Error: \[traducción\] Groq 503/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('an aborted signal stops the call and its retries', async () => {
  const controller = new AbortController();
  const { calls, restore } = stubFetch(() => failing(503, ''));
  try {
    await assert.rejects(
      () => callTranscribe(settingsFor('openai'), samples, { signal: controller.signal, sleep: async () => { controller.abort(); } }),
      { name: 'AbortError' },
    );
    assert.equal(calls.length, 1);
    await assert.rejects(() => callChat(settingsFor('groq', 'gemini'), { system: 's', user: 'u', signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls.length, 1, 'an already-aborted signal sends nothing');
  } finally {
    restore();
  }
});

test('a malformed body is staged', async () => {
  const { restore } = stubFetch(() => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('Unexpected token'); } }));
  try {
    await assert.rejects(() => callTranscribe(settingsFor('gemini'), samples, {}), /^Error: \[transcripción\] Respuesta de Google Gemini inválida/);
  } finally {
    restore();
  }
});

test('redact covers Gemini- and Anthropic-shaped keys and any literal key given', () => {
  assert.equal(redact('k AIzaSyD-0123456789abcdefghij x'), 'k «API key oculta» x');
  assert.equal(redact('k sk-ant-api03-abcdef x'), 'k «API key oculta» x');
  assert.equal(redact('k plain-local-secret x', ['plain-local-secret']), 'k «API key oculta» x');
  assert.equal(redact('nothing', ['']), 'nothing');
});

test('a short local key cannot garble error messages', () => {
  assert.equal(redact('Model not found: llama3.2', ['a']), 'Model not found: llama3.2');
  assert.equal(redact('the model is loading', ['mode']), 'the model is loading');
  assert.equal(redact('k 12345678 x', ['12345678']), 'k «API key oculta» x');
});

test('a blocked or empty Gemini chat response is a staged Spanish error', () => {
  const stage = '[coach]';
  assert.throws(() => parseChat('gemini', { promptFeedback: { blockReason: 'SAFETY' } }, stage), /^Error: \[coach\] Gemini bloqueó esta respuesta \(SAFETY\)\./);
  assert.throws(() => parseChat('gemini', { candidates: [] }, stage), /\(sin respuesta\)/);
  for (const finishReason of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT']) {
    assert.throws(() => parseChat('gemini', { candidates: [{ content: { parts: [{ text: 'half' }] }, finishReason }] }, stage), new RegExp(`\\(${finishReason}\\)`));
  }
  assert.throws(() => parseChat('gemini', { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }, '[traducción]'), /^Error: \[traducción\] Gemini no devolvió texto\./);
  assert.equal(parseChat('gemini', { candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] }, stage), 'cut');
});

test('Claude offers its models in Ajustes, the default among them', () => {
  const p = PROVIDERS.find((x) => x.id === 'anthropic');
  const ids = p.choices.chat.map((c) => c.id);
  assert.deepEqual(ids, ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.ok(ids.includes(p.models.chat));
  for (const c of p.choices.chat) assert.match(c.label, / — /);
});
