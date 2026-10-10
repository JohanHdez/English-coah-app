import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord, checkRoom } from './docs-record.js';
import { DocumentError, LIMITS } from './docs-extract.js';

const file = { name: 'cv.pdf', size: 1234, type: 'application/pdf' };

test('a record keeps passages and counts, never bytes', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about payments.`).join(' ');
  const rec = makeRecord(file, { text }, { id: 'a', now: 5 });
  assert.equal(rec.id, 'a');
  assert.equal(rec.type, 'pdf');
  assert.equal(rec.chars, text.length);
  assert.equal(rec.enabled, true);
  assert.ok(rec.passages.length > 1);
  assert.deepEqual(Object.keys(rec.passages[0]), ['id', 'text']);
  assert.deepEqual(Object.keys(rec).sort(), ['addedAt', 'chars', 'enabled', 'id', 'name', 'passages', 'size', 'type']);
});

test('no text is a Spanish [documentos] error', () => {
  assert.throws(() => makeRecord(file, { text: '  ' }, { id: 'a' }), DocumentError);
});

test('the eleventh document is refused', () => {
  checkRoom(LIMITS.files - 1);
  assert.throws(() => checkRoom(LIMITS.files), /\[documentos\] Ya tienes 10 documentos/);
});
