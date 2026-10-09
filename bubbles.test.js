import test from 'node:test';
import assert from 'node:assert/strict';
import { foldTranslation, nearBottom, createMeetingGate, createSerialQueue, withTranslations, mayInstallCapture } from './bubbles.js';

test('foldTranslation: a brand new bubble carries no translation yet', () => {
  assert.deepEqual(foldTranslation(undefined, 'Hello.'), { text: 'Hello.' });
});

test('foldTranslation: unchanged text keeps the finished translation', () => {
  const prev = { text: 'Hello.', es: 'Hola.' };
  assert.deepEqual(foldTranslation(prev, 'Hello.'), { text: 'Hello.', es: 'Hola.', esStale: undefined });
});

test('foldTranslation: changed text demotes a finished translation to stale', () => {
  const prev = { text: 'Hello', es: 'Hola' };
  assert.deepEqual(foldTranslation(prev, 'Hello there'), { text: 'Hello there', esStale: 'Hola' });
});

test('foldTranslation: changed text keeps an already-stale translation stale', () => {
  const prev = { text: 'Hello', esStale: 'Hola' };
  assert.deepEqual(foldTranslation(prev, 'Hello there'), { text: 'Hello there', esStale: 'Hola' });
});

test('foldTranslation: changed text with nothing cached yet stays plain', () => {
  const prev = { text: 'Hello' };
  assert.deepEqual(foldTranslation(prev, 'Hello there'), { text: 'Hello there' });
});

test('nearBottom: true once within the default 48px threshold', () => {
  assert.equal(nearBottom(1000, 352, 600), false); // exactly 48px away: not "<"
  assert.equal(nearBottom(1000, 353, 600), true); // 47px away
  assert.equal(nearBottom(1000, 400, 600), true); // scrolled all the way down
});

test('nearBottom: false when scrolled well above the foot', () => {
  assert.equal(nearBottom(2000, 0, 600), false);
});

test('nearBottom: a custom threshold is honoured', () => {
  assert.equal(nearBottom(1000, 900, 50, 60), true);
  assert.equal(nearBottom(1000, 900, 50, 40), false);
});

function recorder() {
  const seen = [];
  return { seen, handler: (event) => seen.push(event) };
}

test('createMeetingGate: an event from the current session is handled', () => {
  const gate = createMeetingGate();
  const { seen, handler } = recorder();
  const onEvent = gate.bind(handler);
  onEvent({ type: 'bubble', entry: { t: 1, text: 'Hello.' } });
  assert.deepEqual(seen, [{ type: 'bubble', entry: { t: 1, text: 'Hello.' } }]);
});

test('createMeetingGate: an event that lands after Terminar is dropped', () => {
  const gate = createMeetingGate();
  const { seen, handler } = recorder();
  const onEvent = gate.bind(handler);
  gate.close();
  onEvent({ type: 'bubble', entry: { t: 1, text: 'Late.' } });
  assert.deepEqual(seen, []);
});

test('createMeetingGate: an event from a previous meeting\'s session is dropped after Nueva reunión', () => {
  const gate = createMeetingGate();
  const { seen, handler } = recorder();
  const oldSession = gate.bind(handler);
  gate.close();
  const newSession = gate.bind(handler);
  oldSession({ type: 'error', text: '[groq] stale' });
  newSession({ type: 'bubble', entry: { t: 2, text: 'Fresh.' } });
  assert.deepEqual(seen, [{ type: 'bubble', entry: { t: 2, text: 'Fresh.' } }]);
});

test('createMeetingGate: a newer session supersedes an older one even without close()', () => {
  const gate = createMeetingGate();
  const { seen, handler } = recorder();
  const first = gate.bind(handler);
  gate.bind(handler);
  first({ type: 'bubble', entry: { t: 1, text: 'Stale.' } });
  assert.deepEqual(seen, []);
});

test('createSerialQueue runs one task at a time, in order, past a failure', async () => {
  const enqueue = createSerialQueue();
  const log = [];
  let running = 0;
  const task = (name, ms, fail) => async () => {
    running++;
    assert.equal(running, 1, 'never two at once');
    await new Promise((r) => setTimeout(r, ms));
    log.push(name);
    running--;
    if (fail) throw new Error(name);
    return name;
  };
  const a = enqueue(task('a', 15));
  const b = enqueue(task('b', 1, true));
  const c = enqueue(task('c', 5));
  assert.equal(await a, 'a');
  await assert.rejects(b, /b/);
  assert.equal(await c, 'c');
  assert.deepEqual(log, ['a', 'b', 'c']);
});

test('withTranslations stores the Spanish only for the words it translated', () => {
  const entries = [
    { t: 1, text: 'Hello.', speaker: 'them' },
    { t: 2, text: 'How are you doing', speaker: 'them' },
    { t: 3, text: 'Fine.', speaker: 'me' },
  ];
  const cache = new Map([
    [1, { text: 'Hello.', es: 'Hola.' }],
    [2, { text: 'How are you', es: '¿Cómo estás?' }],
  ]);
  const out = withTranslations(entries, cache);
  assert.equal(out[0].es, 'Hola.');
  assert.equal(out[1].es, undefined, 'stale: the bubble grew after it was translated');
  assert.equal(out[2].es, undefined);
  assert.equal(entries[0].es, undefined, 'the live entries are not mutated');
});

test('mayInstallCapture: a live meeting takes the capture it just opened', () => {
  assert.equal(mayInstallCapture({ destroyed: false, stopping: false, finishedAt: null }), true);
});

test('mayInstallCapture: nothing is installed once the screen is gone, Terminar was tapped, or the meeting finished', () => {
  assert.equal(mayInstallCapture({ destroyed: true, stopping: false, finishedAt: null }), false);
  assert.equal(mayInstallCapture({ destroyed: false, stopping: true, finishedAt: null }), false);
  assert.equal(mayInstallCapture({ destroyed: false, stopping: false, finishedAt: 1 }), false);
});

test('mayInstallCapture: a live meeting takes the capture it just opened', () => {
  assert.equal(mayInstallCapture({ destroyed: false, stopping: false, finishedAt: null }), true);
});

test('mayInstallCapture: nothing is installed once the screen is gone, Terminar was tapped, or the meeting finished', () => {
  assert.equal(mayInstallCapture({ destroyed: true, stopping: false, finishedAt: null }), false);
  assert.equal(mayInstallCapture({ destroyed: false, stopping: true, finishedAt: null }), false);
  assert.equal(mayInstallCapture({ destroyed: false, stopping: false, finishedAt: 1 }), false);
});
