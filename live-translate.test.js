import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, createLiveTranslator } from './live-translate.js';

const tick = () => new Promise((r) => setImmediate(r));

function rig({ sentences = true, gapMs = 400 } = {}) {
  let t = 0;
  const timers = [];
  const calls = [];
  const pending = [];
  const shown = [];
  const lt = createLiveTranslator({
    sentences,
    gapMs,
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    translate: (text) => { calls.push(text); return new Promise((resolve) => pending.push({ text, resolve })); },
    onText: (text) => shown.push(text),
  });
  return {
    lt, calls, shown,
    answer: async (fn = (s) => `es:${s}`) => { for (const p of pending.splice(0)) p.resolve(fn(p.text)); await tick(); },
    advance: async (ms) => {
      t += ms;
      for (const h of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(h), 1); h.fn(); }
      await tick();
    },
    last: () => shown.at(-1) ?? '',
  };
}

test('splitSentences keeps the unfinished sentence as the tail', () => {
  assert.deepEqual(splitSentences('Hello there. How are you? I am'), { done: ['Hello there.', 'How are you?'], tail: 'I am' });
  assert.deepEqual(splitSentences('No end yet'), { done: [], tail: 'No end yet' });
  assert.deepEqual(splitSentences(''), { done: [], tail: '' });
});

test('the line being spoken is translated at once, then no sooner than the gap', async () => {
  const r = rig({ gapMs: 400 });
  r.lt.update('We are moving');
  assert.deepEqual(r.calls, ['We are moving']);
  r.lt.update('We are moving the payment');
  assert.equal(r.calls.length, 1, 'one request in flight at a time');
  await r.answer();
  assert.equal(r.last(), 'es:We are moving');
  assert.equal(r.calls.length, 1, 'the gap holds the next one back');
  await r.advance(400);
  assert.deepEqual(r.calls.at(-1), 'We are moving the payment');
  await r.answer();
  assert.equal(r.last(), 'es:We are moving the payment');
});

test('a finished sentence is translated once and kept while the next is spoken', async () => {
  const r = rig({ gapMs: 0 });
  r.lt.update('Thanks for joining. I want');
  await r.answer();
  assert.equal(r.last(), 'es:Thanks for joining. es:I want');
  r.lt.update('Thanks for joining. I want to walk you');
  await r.answer();
  assert.equal(r.calls.filter((c) => c === 'Thanks for joining.').length, 1);
  assert.equal(r.last(), 'es:Thanks for joining. es:I want to walk you');
});

test('with sentences off only the whole line is sent', async () => {
  const r = rig({ sentences: false, gapMs: 0 });
  r.lt.update('Thanks for joining. I want');
  await r.answer();
  assert.deepEqual(r.calls, ['Thanks for joining. I want']);
  assert.equal(r.last(), 'es:Thanks for joining. I want');
});

test('a revised ending keeps the translation shown until the new one lands', async () => {
  const r = rig({ sentences: false, gapMs: 0 });
  r.lt.update('Can you share the deck');
  await r.answer();
  r.lt.update('Can you share the check with');
  assert.equal(r.last(), 'es:Can you share the deck');
});

test('a new phrase does not show the previous phrase translation', async () => {
  const r = rig({ sentences: false, gapMs: 0 });
  r.lt.update('First we migrate');
  await r.answer();
  r.lt.update('Second the mobile team');
  assert.equal(r.last(), '');
});

test('clear() empties the line and drops answers already on their way', async () => {
  const r = rig({ gapMs: 0 });
  r.lt.update('Hello');
  r.lt.clear();
  await r.answer();
  assert.equal(r.last(), '');
});

test('a failed translation shows nothing and is retried on the next update', async () => {
  const r = rig({ gapMs: 0 });
  r.lt.update('Done here. Next');
  await r.answer(() => '');
  assert.equal(r.last(), '');
  r.lt.update('Done here. Next one');
  assert.ok(r.calls.filter((c) => c === 'Done here.').length === 2);
});
