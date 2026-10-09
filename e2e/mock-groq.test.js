// The stand-in must answer exactly what providers.js sends: each provider's real
// request, built by the app's own adapters, round-trips through it and parses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockGroq, STAND_IN_ANSWER } from './mock-groq.mjs';
import { askReply } from '../lib/coach.js';
import { callTranscribe, callChat, migrateSettings } from '../providers.js';

const manifest = { cues: [{ key: 'c0', start: 0, end: 60, text: 'hello there my friend', speaker: 'other', lang: 'en' }] };
const samples = new Float32Array(16000).map((_, i) => Math.sin(i / 7) / 4);
const KEYS = { groq: 'gsk_mock_0000000', openai: 'sk-mock-0000000', gemini: 'AIzaMock0000000', anthropic: 'sk-ant-mock-0000000', local: '' };

test('every provider shape round-trips through the stand-in, its key in its own header', async () => {
  const mock = await startMockGroq({ manifest, delayMs: 0 });
  mock.setT0(Date.now() - 10000);
  try {
    const bases = { openai: mock.url, gemini: mock.url, anthropic: mock.url };
    for (const id of ['groq', 'openai', 'gemini']) {
      const settings = migrateSettings({ transcribeProvider: id, chatProvider: id, keys: KEYS, groqBase: mock.url, bases });
      const out = await callTranscribe(settings, samples, {});
      assert.equal(out.text, 'hello there my friend', id);
    }
    for (const id of ['groq', 'openai', 'gemini', 'anthropic']) {
      const settings = migrateSettings({ transcribeProvider: 'groq', chatProvider: id, keys: KEYS, groqBase: mock.url, bases });
      assert.equal(await callChat(settings, { system: 's', user: 'Good morning' }), '[es] Good morning', id);
    }
    assert.deepEqual(mock.requests.map((r) => [r.provider, r.auth]), [['groq', true], ['openai', true], ['gemini', true]]);
    assert.deepEqual(mock.chats.map((r) => [r.provider, r.auth]), [['groq', true], ['openai', true], ['gemini', true], ['anthropic', true]]);
    assert.equal(mock.requests[2].seconds, 1, 'the Gemini WAV is decoded from base64');
  } finally {
    await mock.close();
  }
});

test('askReply parses the stand-in\'s answer on every chat provider', async () => {
  const mock = await startMockGroq({ manifest, delayMs: 0 });
  try {
    const bases = { openai: mock.url, gemini: mock.url, anthropic: mock.url };
    for (const id of ['groq', 'openai', 'gemini', 'anthropic']) {
      const settings = migrateSettings({ transcribeProvider: 'groq', chatProvider: id, keys: KEYS, groqBase: mock.url, bases });
      const out = await askReply({ turns: [{ speaker: 'them', lang: 'en', text: 'What do you work with?' }], settings });
      assert.equal(out.answer[0].en, STAND_IN_ANSWER, id);
      assert.equal(out.ideas.length, 2, id);
    }
  } finally {
    await mock.close();
  }
});
