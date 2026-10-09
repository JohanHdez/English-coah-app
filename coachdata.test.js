import test from 'node:test';
import assert from 'node:assert/strict';
import {
  richParts, plainReply, addCustomPhrase, removeCustomPhrase, deleteNote,
  categoryActive, setCategoryActive, replyTurns, clampField, saveFailureText, CUSTOM_PHRASE_MAX,
} from './coachdata.js';
import { resolvePhrases, MAX_CUSTOM, DEFAULT_PHRASE_IDS } from './lib/phrasebook.js';

test('richParts marks the term between double asterisks', () => {
  assert.deepEqual(richParts('I use **signals** daily.'), [
    { text: 'I use ', bold: false }, { text: 'signals', bold: true }, { text: ' daily.', bold: false },
  ]);
  assert.deepEqual(richParts('plain'), [{ text: 'plain', bold: false }]);
  assert.deepEqual(richParts(''), []);
});

test('richParts leaves an unpaired marker plain instead of bolding the tail', () => {
  assert.deepEqual(richParts('It is **sig'), [{ text: 'It is ', bold: false }, { text: 'sig', bold: false }]);
});

test('plainReply strips the markers for copying', () => {
  assert.equal(plainReply('I use **signals** daily.'), 'I use signals daily.');
});

test('addCustomPhrase appends, clamps and shows up in resolvePhrases', () => {
  const next = addCustomPhrase({}, { en: '  Let me circle back.  ', es: 'vuelvo a eso' }, 5);
  assert.equal(next.customPhrases.length, 1);
  assert.equal(next.customPhrases[0].id, 'c.5.0');
  assert.ok(resolvePhrases(next).some((p) => p.en === 'Let me circle back.' && p.cat === 'Mis frases'));
  const long = addCustomPhrase({}, { en: 'x'.repeat(CUSTOM_PHRASE_MAX + 50) });
  assert.equal(long.customPhrases[0].en.length, CUSTOM_PHRASE_MAX);
});

test('addCustomPhrase refuses empty text and a full list; ids stay distinct within a millisecond', () => {
  const s = {};
  assert.equal(addCustomPhrase(s, { en: '   ' }), s);
  let full = {};
  for (let i = 0; i < MAX_CUSTOM; i++) full = addCustomPhrase(full, { en: `p${i}` }, 7);
  assert.equal(full.customPhrases.length, MAX_CUSTOM);
  assert.equal(new Set(full.customPhrases.map((p) => p.id)).size, MAX_CUSTOM);
  assert.equal(addCustomPhrase(full, { en: 'one more' }), full);
});

test('removeCustomPhrase and deleteNote drop one item by id and keep the rest', () => {
  const s = { customPhrases: [{ id: 'a', en: 'A' }, { id: 'b', en: 'B' }], notes: [{ id: 'n1', title: 'x' }, { id: 'n2', title: 'y' }] };
  assert.deepEqual(removeCustomPhrase(s, 'a').customPhrases.map((p) => p.id), ['b']);
  assert.deepEqual(deleteNote(s, 'n1').notes.map((n) => n.id), ['n2']);
  assert.deepEqual(deleteNote({}, 'n1').notes, []);
});

test('categories: the default selection reads as active, and switching one keeps the others', () => {
  assert.equal(categoryActive({}, 'Ganar tiempo'), true);
  assert.equal(categoryActive({}, 'Cerrar'), false);
  assert.equal(categoryActive({}, 'No existe'), false);
  const on = setCategoryActive({}, 'Cerrar', true);
  assert.equal(categoryActive(on, 'Cerrar'), true);
  assert.equal(categoryActive(on, 'Ganar tiempo'), true);
  assert.ok(resolvePhrases(on).some((p) => p.cat === 'Cerrar'));
  const off = setCategoryActive(on, 'Ganar tiempo', false);
  assert.equal(categoryActive(off, 'Ganar tiempo'), false);
  assert.equal(categoryActive(off, 'Pedir aclaración'), true);
  assert.deepEqual(setCategoryActive({}, 'Ganar tiempo', true).phraseIds.sort(), [...DEFAULT_PHRASE_IDS].sort());
});

test('an explicitly empty selection stays empty until a category is switched on', () => {
  const none = setCategoryActive({}, 'Ganar tiempo', false);
  const none2 = setCategoryActive(none, 'Pedir aclaración', false);
  assert.deepEqual(none2.phraseIds, []);
  assert.deepEqual(resolvePhrases(none2), []);
});

test('replyTurns puts restored turns first and drops blank text', () => {
  const out = replyTurns([{ speaker: 'them', text: 'a' }, { speaker: 'me', text: ' ' }], [{ speaker: 'me', text: 'b' }, null]);
  assert.deepEqual(out.map((t) => t.text), ['a', 'b']);
});

test('clampField cuts to the limit', () => {
  assert.equal(clampField('abcdef', 3), 'abc');
  assert.equal(clampField(undefined, 3), '');
});

test('saveFailureText names what was not saved, staged [almacenamiento]', () => {
  assert.equal(saveFailureText('note'), '[almacenamiento] No se pudo guardar la nota.');
  assert.equal(saveFailureText('profile'), '[almacenamiento] No se pudo guardar tu perfil.');
  assert.equal(saveFailureText('other'), '[almacenamiento] No se pudo guardar el cambio.');
});
