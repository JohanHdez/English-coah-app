import test from 'node:test';
import assert from 'node:assert/strict';
import { foldTranslation, nearBottom } from './bubbles.js';

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
