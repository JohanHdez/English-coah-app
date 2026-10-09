import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, redact, parseRetryAfter, retryDelayMs, isRetryableStatus, RETRIES, MAX_WAIT_MS } from './transcribe.js';
import { migrateSettings } from './providers.js';

// The Phase 1 tests, run through the provider-agnostic entry point with Groq chosen.
const transcribeGroq = (samples, { key, base, lang, signal, sleep } = {}) =>
  transcribe(samples, migrateSettings({ groqKey: key, groqBase: base, lang }), { signal, sleep });

const noWait = async () => {};

// Stub for Groq's transcription endpoint: captures the multipart form instead of
// hitting the network.
function stubGroq(capture, respond) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capture.url = url;
    capture.form = init.body;
    capture.signal = init.signal;
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
    ok: false, status: 400, text: async () => 'bad key: gsk_abcdef0123456789',
  }));
  try {
    await assert.rejects(
      () => transcribeGroq(samples, { key: 'gsk_test' }),
      (err) => {
        assert.ok(err.message.startsWith('[transcripción] Groq 400:'));
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
      /\[transcripción\] Falta la API key de Groq\./,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// Fix round 1, finding 9: these two paths forwarded the native error message
// (`TypeError: Failed to fetch`, a `SyntaxError` from a malformed body) with no
// stage prefix, so they reached the UI looking unlike every other Groq failure.
test('a network failure is reported with the [transcripción] prefix', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(
      () => transcribeGroq(samples, { key: 'gsk_test', sleep: noWait }),
      (err) => { assert.ok(err.message.startsWith('[transcripción]'), err.message); return true; },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a malformed response body is reported with the [transcripción] prefix', async () => {
  const restore = stubGroq({}, () => ({
    ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); },
  }));
  try {
    await assert.rejects(
      () => transcribeGroq(samples, { key: 'gsk_test' }),
      (err) => { assert.ok(err.message.startsWith('[transcripción]'), err.message); return true; },
    );
  } finally {
    restore();
  }
});

test('the request carries an abort signal, so a stalled connection cannot hang forever', async () => {
  const capture = {};
  const restore = stubGroq(capture, () => ({ ok: true, status: 200, json: async () => ({ text: 'x' }) }));
  try {
    await transcribeGroq(samples, { key: 'gsk_test' });
    assert.ok(capture.signal instanceof AbortSignal, 'fetch must receive a signal');
  } finally {
    restore();
  }
});

test('a timed-out request is reported with the [transcripción] prefix, like any other network failure', async () => {
  const restore = stubGroq({}, () => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
  try {
    await assert.rejects(
      () => transcribeGroq(samples, { key: 'gsk_test', sleep: noWait }),
      (err) => { assert.ok(err.message.startsWith('[transcripción]'), err.message); return true; },
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

// Final review, finding 4: a 429, a 5xx or a dropped connection lost the
// segment's words for good.
function scripted(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const spec = responses[Math.min(calls.length, responses.length - 1)];
    calls.push(init);
    if (spec.throws) throw new TypeError('Failed to fetch');
    return {
      ok: spec.status === 200,
      status: spec.status,
      headers: new Headers(spec.headers || {}),
      text: async () => spec.body || '',
      json: async () => ({ text: spec.text || 'ok' }),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function recordingSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('429, 5xx and network failures are retried, up to two retries', async () => {
  for (const first of [{ status: 429 }, { status: 503 }, { throws: true }]) {
    const { calls, restore } = scripted([first, first, { status: 200, text: 'recovered' }]);
    const { waits, sleep } = recordingSleep();
    try {
      const out = await transcribeGroq(samples, { key: 'gsk_test', sleep });
      assert.equal(out.text, 'recovered');
      assert.equal(calls.length, 3);
      assert.deepEqual(waits, [1000, 2000], 'exponential backoff without Retry-After');
    } finally {
      restore();
    }
  }
});

test('the third failure is reported, not retried again', async () => {
  const { calls, restore } = scripted([{ status: 500, body: 'down' }]);
  try {
    await assert.rejects(() => transcribeGroq(samples, { key: 'gsk_test', sleep: noWait }), /^Error: \[transcripción\] Groq 500: down/);
    assert.equal(calls.length, 1 + RETRIES);
  } finally {
    restore();
  }
});

test('a 4xx other than 429 is never retried', async () => {
  for (const status of [400, 401, 403, 404, 413]) {
    const { calls, restore } = scripted([{ status }]);
    try {
      await assert.rejects(() => transcribeGroq(samples, { key: 'gsk_test', sleep: noWait }), /\[transcripción\]/);
      assert.equal(calls.length, 1, `status ${status}`);
    } finally {
      restore();
    }
  }
});

test('401 and 429 read as plain Spanish', async () => {
  let { restore } = scripted([{ status: 401, body: 'gsk_abcdef0123456789' }]);
  try {
    await assert.rejects(() => transcribeGroq(samples, { key: 'gsk_test', sleep: noWait }), /^Error: \[transcripción\] Clave de Groq no válida\.$/);
  } finally {
    restore();
  }
  ({ restore } = scripted([{ status: 429 }]));
  try {
    await assert.rejects(() => transcribeGroq(samples, { key: 'gsk_test', sleep: noWait }), /\[transcripción\] Groq está limitando las peticiones/);
  } finally {
    restore();
  }
});

test('Retry-After is honoured, and capped', async () => {
  const { restore } = scripted([
    { status: 429, headers: { 'retry-after': '3' } },
    { status: 429, headers: { 'retry-after': '120' } },
    { status: 200 },
  ]);
  const { waits, sleep } = recordingSleep();
  try {
    await transcribeGroq(samples, { key: 'gsk_test', sleep });
    assert.deepEqual(waits, [3000, MAX_WAIT_MS]);
  } finally {
    restore();
  }
});

test('parseRetryAfter reads seconds and HTTP dates, and ignores garbage', () => {
  const now = Date.parse('Thu, 01 Oct 2026 10:00:00 GMT');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('0.5', now), 500);
  assert.equal(parseRetryAfter('Thu, 01 Oct 2026 10:00:04 GMT', now), 4000);
  assert.equal(parseRetryAfter('Thu, 01 Oct 2026 09:59:00 GMT', now), 0, 'a date in the past means now');
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('', now), null);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter('-3', now), null);
});

test('retryDelayMs doubles from one second and never exceeds the cap', () => {
  assert.equal(retryDelayMs(0), 1000);
  assert.equal(retryDelayMs(1), 2000);
  assert.equal(retryDelayMs(5), MAX_WAIT_MS);
  assert.equal(retryDelayMs(0, 4500), 4500);
  assert.equal(retryDelayMs(0, 0), 0);
  assert.equal(retryDelayMs(1, 60000), MAX_WAIT_MS);
});

test('isRetryableStatus is 429 and 5xx only', () => {
  assert.deepEqual([200, 400, 401, 404, 429, 500, 502, 599, 600].map(isRetryableStatus),
    [false, false, false, false, true, true, true, true, false]);
});

test('an aborted session signal stops the upload and its retries', async () => {
  const controller = new AbortController();
  const { calls, restore } = scripted([{ status: 503 }]);
  try {
    const sleep = async () => { controller.abort(); };
    await assert.rejects(() => transcribeGroq(samples, { key: 'gsk_test', signal: controller.signal, sleep }), { name: 'AbortError' });
    assert.equal(calls.length, 1, 'no retry after the abort');
  } finally {
    restore();
  }
  const { calls: none, restore: restore2 } = scripted([{ status: 200 }]);
  try {
    await assert.rejects(() => transcribeGroq(samples, { key: 'gsk_test', signal: controller.signal }), { name: 'AbortError' });
    assert.equal(none.length, 0, 'an already-aborted signal sends nothing');
  } finally {
    restore2();
  }
});

test('the default backoff wait itself ends early on abort', async () => {
  const controller = new AbortController();
  const { restore } = scripted([{ status: 503 }]);
  try {
    const t0 = Date.now();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => transcribeGroq(samples, { key: 'gsk_test', signal: controller.signal }), { name: 'AbortError' });
    assert.ok(Date.now() - t0 < 500, 'the 1 s backoff was cut short');
  } finally {
    restore();
  }
});
