import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeGroq, redact } from './transcribe.js';

// Stub for Groq's transcription endpoint: captures the multipart form instead of
// hitting the network.
function stubGroq(capture, respond) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capture.url = url;
    capture.form = init.body;
    return respond();
  };
  return () => { globalThis.fetch = original; };
}

const samples = Float32Array.from({ length: 10 }, (_, i) => (i - 5) / 10);

test('a single-language request pins the language and asks for plain json', async () => {
  const capture = {};
  const restore = stubGroq(capture, () => ({ ok: true, status: 200, json: async () => ({ text: 'Hello.' }) }));
  try {
    const out = await transcribeGroq(samples, { key: 'gsk_test', lang: 'es' });
    assert.equal(out.text, 'Hello.');
    assert.equal(out.lang, null, 'json (non-verbose) carries no language field to map');
    assert.equal(capture.form.get('language'), 'es');
    assert.equal(capture.form.get('response_format'), 'json');
    assert.equal(capture.form.get('model'), 'whisper-large-v3-turbo');
    assert.equal(capture.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  } finally {
    restore();
  }
});

test('a bilingual session omits the language and requests verbose_json', async () => {
  const capture = {};
  const restore = stubGroq(capture, () => ({
    ok: true, status: 200, json: async () => ({ text: 'Hola.', language: 'spanish' }),
  }));
  try {
    const out = await transcribeGroq(samples, { key: 'gsk_test', lang: 'multi' });
    assert.equal(capture.form.has('language'), false);
    assert.equal(capture.form.get('response_format'), 'verbose_json');
    assert.equal(out.lang, 'es');
  } finally {
    restore();
  }
});

test('the reported language name maps english/spanish and anything else to null', async () => {
  const capture = {};
  for (const [reported, expected] of [['english', 'en'], ['spanish', 'es'], ['french', null], [undefined, null]]) {
    const restore = stubGroq(capture, () => ({
      ok: true, status: 200, json: async () => ({ text: 'x', language: reported }),
    }));
    try {
      const out = await transcribeGroq(samples, { key: 'gsk_test', lang: 'multi' });
      assert.equal(out.lang, expected, `reported "${reported}" should map to ${expected}`);
    } finally {
      restore();
    }
  }
});

test('a custom base is honoured and its trailing slash is tolerated', async () => {
  const capture = {};
  const restore = stubGroq(capture, () => ({ ok: true, status: 200, json: async () => ({ text: 'x' }) }));
  try {
    await transcribeGroq(samples, { key: 'k', base: 'http://127.0.0.1:4000/' });
    assert.equal(capture.url, 'http://127.0.0.1:4000/openai/v1/audio/transcriptions');
  } finally {
    restore();
  }
});

test('a non-ok response raises a stage-prefixed, redacted, truncated error', async () => {
  const restore = stubGroq({}, () => ({
    ok: false, status: 401, text: async () => 'bad key: gsk_abcdef0123456789',
  }));
  try {
    await assert.rejects(
      () => transcribeGroq(samples, { key: 'gsk_test' }),
      (err) => {
        assert.ok(err.message.startsWith('[groq] Groq 401:'));
        assert.ok(!err.message.includes('gsk_abcdef0123456789'), 'the key must never reach the message');
        assert.ok(err.message.includes('«API key oculta»'));
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('a missing key fails before any network call', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  try {
    await assert.rejects(
      () => transcribeGroq(samples, {}),
      /\[groq\] Falta la API key de Groq\./,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// Fix round 1, finding 9: these two paths forwarded the native error message
// (`TypeError: Failed to fetch`, a `SyntaxError` from a malformed body) with no
// stage prefix, so they reached the UI looking unlike every other Groq failure.
test('a network failure is reported with the [groq] prefix', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(
      () => transcribeGroq(samples, { key: 'gsk_test' }),
      (err) => { assert.ok(err.message.startsWith('[groq]'), err.message); return true; },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a malformed response body is reported with the [groq] prefix', async () => {
  const restore = stubGroq({}, () => ({
    ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); },
  }));
  try {
    await assert.rejects(
      () => transcribeGroq(samples, { key: 'gsk_test' }),
      (err) => { assert.ok(err.message.startsWith('[groq]'), err.message); return true; },
    );
  } finally {
    restore();
  }
});

test('redact hides every key shape without touching the rest of the text', () => {
  assert.equal(redact('key is gsk_AbC123xyz here'), 'key is «API key oculta» here');
  assert.equal(redact('key is sk-AbC123xyz here'), 'key is «API key oculta» here');
  assert.equal(redact('key is xai-AbC123xyz here'), 'key is «API key oculta» here');
  assert.equal(redact('no secret here'), 'no secret here');
  assert.equal(redact(null), '');
});
