import test from 'node:test';
import assert from 'node:assert/strict';
import { toSpanish } from './translate.js';

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

// translate.js caches the Translator's availability in module state after the
// first check, so each test that cares about that path defines its own
// Translator and restores (or clears) the global afterwards.
function stubTranslator(impl) {
  const original = globalThis.Translator;
  globalThis.Translator = impl;
  return () => {
    if (original === undefined) delete globalThis.Translator;
    else globalThis.Translator = original;
  };
}

test('empty text short-circuits before any network call or Translator check', async () => {
  const restore = stubFetch(async () => { throw new Error('must not be called'); });
  try {
    assert.equal(await toSpanish(''), '');
    assert.equal(await toSpanish(null), '');
  } finally {
    restore();
  }
});

test('with no Translator in the environment, the chosen chat provider (Groq by default) is used', async () => {
  assert.equal(typeof globalThis.Translator, 'undefined');
  const capture = {};
  const restore = stubFetch(async (url, init) => {
    capture.url = url;
    capture.init = init;
    return { ok: true, json: async () => ({ choices: [{ message: { content: ' Hola, ¿cómo estás? ' } }] }) };
  });
  try {
    const out = await toSpanish('Hello, how are you?', { keys: { groq: 'gsk_test' } });
    assert.equal(out, 'Hola, ¿cómo estás?');
    assert.equal(capture.url, 'https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(capture.init.body);
    assert.equal(body.model, 'openai/gpt-oss-120b', 'the chat provider\'s model');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].content, 'Hello, how are you?');
    assert.equal(capture.init.headers.Authorization, 'Bearer gsk_test');
    assert.ok(capture.init.signal instanceof AbortSignal, 'fetch must receive a signal');
  } finally {
    restore();
  }
});

test('a custom base is honoured for the Groq fallback', async () => {
  const capture = {};
  const restore = stubFetch(async (url) => {
    capture.url = url;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hola.' } }] }) };
  });
  try {
    await toSpanish('Hello.', { keys: { groq: 'k' }, groqBase: 'http://127.0.0.1:4000/' });
    assert.equal(capture.url, 'http://127.0.0.1:4000/openai/v1/chat/completions');
  } finally {
    restore();
  }
});

test('no key: the Groq fallback returns empty rather than calling fetch', async () => {
  const restore = stubFetch(async () => { throw new Error('must not be called'); });
  try {
    assert.equal(await toSpanish('Hello.', {}), '');
  } finally {
    restore();
  }
});

test('a non-ok Groq response resolves to empty, never throws', async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 500 }));
  try {
    assert.equal(await toSpanish('Hello.', { keys: { groq: 'k' } }), '');
  } finally {
    restore();
  }
});

test('a network failure resolves to empty, never throws', async () => {
  const restore = stubFetch(async () => { throw new TypeError('Failed to fetch'); });
  try {
    assert.equal(await toSpanish('Hello.', { keys: { groq: 'k' } }), '');
  } finally {
    restore();
  }
});

test('a timed-out request resolves to empty, never throws: a translation is not worth a staged error', async () => {
  const restore = stubFetch(async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
  try {
    assert.equal(await toSpanish('Hello.', { keys: { groq: 'k' } }), '');
  } finally {
    restore();
  }
});

test('the fallback follows the chat provider the learner chose, its key only in its header', async () => {
  const capture = {};
  const restore = stubFetch(async (url, init) => {
    capture.url = url;
    capture.init = init;
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Hola.' }] }) };
  });
  try {
    const out = await toSpanish('Hello.', { chatProvider: 'anthropic', keys: { groq: 'gsk_unused', anthropic: 'sk-ant-test-0000' } });
    assert.equal(out, 'Hola.');
    assert.equal(capture.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(capture.init.headers['x-api-key'], 'sk-ant-test-0000');
    assert.ok(!JSON.stringify(capture.init.headers).includes('gsk_unused'));
  } finally {
    restore();
  }
});

test('a translation failure is never retried', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return { ok: false, status: 503, text: async () => '' }; });
  try {
    assert.equal(await toSpanish('Hello.', { keys: { groq: 'k' } }), '');
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});
