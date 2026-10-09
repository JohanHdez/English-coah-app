import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOGUE, DEFAULT_PHRASE_IDS, resolvePhrases, resolveNotes, resolveChips,
  NOTE_TITLE_MAX, NOTE_BODY_MAX, MAX_NOTES, MAX_CUSTOM, toggleNoteOpen, addNote, pickEnglishVoice,
  CUSTOM_CAT, phraseCategories,
} from './phrasebook.js';

const allItems = () => CATALOGUE.flatMap((c) => c.items);

test('every catalogue id is unique', () => {
  const ids = allItems().map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every catalogue entry carries English and a Spanish gloss', () => {
  for (const item of allItems()) {
    assert.ok(item.en && item.en.trim(), `${item.id} has no en`);
    assert.ok(item.es && item.es.trim(), `${item.id} has no es`);
  }
});

test('every seeded default exists in the catalogue', () => {
  const ids = new Set(allItems().map((i) => i.id));
  for (const id of DEFAULT_PHRASE_IDS) assert.ok(ids.has(id), `${id} is not in the catalogue`);
});

test('resolvePhrases returns built-ins in catalogue order, then customs', () => {
  const out = resolvePhrases({
    phraseIds: ['close.sum-up', 'time.second'],
    customPhrases: [{ id: 'u.1', en: 'Ship it,', es: 'a producción' }],
  });
  assert.deepEqual(out.map((p) => p.id), ['time.second', 'close.sum-up', 'u.1']);
});

test('resolvePhrases drops ids no longer in the catalogue instead of throwing', () => {
  const out = resolvePhrases({ phraseIds: ['time.second', 'gone.forever'] });
  assert.deepEqual(out.map((p) => p.id), ['time.second']);
});

test('resolvePhrases on empty settings returns the seeded defaults, not nothing', () => {
  const out = resolvePhrases({});
  assert.equal(out.length, DEFAULT_PHRASE_IDS.length);
  assert.ok(out.length > 0);
});

test('an explicitly empty selection stays empty', () => {
  assert.deepEqual(resolvePhrases({ phraseIds: [] }), []);
});

test('resolvePhrases caps the learner custom phrases', () => {
  const customPhrases = Array.from({ length: MAX_CUSTOM + 10 }, (_, i) => ({
    id: `u.${i}`, en: `phrase ${i}`, es: `frase ${i}`,
  }));
  const out = resolvePhrases({ phraseIds: [], customPhrases });
  assert.equal(out.length, MAX_CUSTOM);
});

test('resolvePhrases discards custom phrases with no English', () => {
  const out = resolvePhrases({ phraseIds: [], customPhrases: [{ id: 'u.1', en: '  ', es: 'x' }] });
  assert.deepEqual(out, []);
});

test('a custom phrase id cannot collide with a catalogue id', () => {
  // Settings writes them as 'u.' + timestamp; no catalogue id may start with 'u.'
  for (const item of allItems()) assert.ok(!item.id.startsWith('u.'), `${item.id} collides`);
});

test('resolveNotes clamps title, body and count', () => {
  const notes = Array.from({ length: MAX_NOTES + 5 }, (_, i) => ({
    id: `n.${i}`, title: 'T'.repeat(NOTE_TITLE_MAX + 20), body: 'B'.repeat(NOTE_BODY_MAX + 500),
  }));
  const out = resolveNotes({ notes });
  assert.equal(out.length, MAX_NOTES);
  assert.equal(out[0].title.length, NOTE_TITLE_MAX);
  assert.equal(out[0].body.length, NOTE_BODY_MAX);
});

test('resolveNotes preserves the open state through a round trip', () => {
  const out = resolveNotes({ notes: [{ id: 'n.1', title: 'Mi daily', body: 'x', open: true }] });
  assert.equal(out[0].open, true);
  assert.equal(resolveNotes({ notes: out })[0].open, true);
});

test('resolveNotes defaults a note to closed and never returns undefined fields', () => {
  const [note] = resolveNotes({ notes: [{ id: 'n.1', title: 'Sin cuerpo' }] });
  assert.equal(note.open, false);
  assert.equal(note.body, '');
});

test('resolveNotes on empty settings returns an empty list', () => {
  assert.deepEqual(resolveNotes({}), []);
  assert.deepEqual(resolveNotes({ notes: null }), []);
});

test('resolveChips returns empty phrases and notes when liveCoach is false', () => {
  const settings = {
    liveCoach: false,
    phraseIds: ['time.second'],
    notes: [{ id: 'n.1', title: 'Mi daily', body: 'x', open: true }],
  };
  assert.deepEqual(resolveChips(settings), { phrases: [], notes: [] });
});

test('resolveChips defaults to on and returns the seeded phrases when liveCoach is absent', () => {
  const out = resolveChips({});
  assert.equal(out.phrases.length, DEFAULT_PHRASE_IDS.length);
  assert.deepEqual(out.notes, []);
});

test('resolveChips returns content when liveCoach is true', () => {
  const settings = {
    liveCoach: true,
    phraseIds: ['time.second'],
    notes: [{ id: 'n.1', title: 'Mi daily', body: 'x', open: true }],
  };
  const out = resolveChips(settings);
  assert.deepEqual(out.phrases.map((p) => p.id), ['time.second']);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].id, 'n.1');
});

test('toggleNoteOpen flips the targeted note and returns a new settings object', () => {
  const settings = {
    liveCoach: true,
    notes: [{ id: 'n.1', title: 'Mi daily', body: 'x', open: false }],
  };
  const out = toggleNoteOpen(settings, 'n.1');
  assert.equal(out.notes[0].open, true);
  assert.equal(settings.notes[0].open, false, 'the input must not be mutated');
  assert.notEqual(out, settings);
  assert.equal(out.liveCoach, true, 'the rest of settings survives');
  assert.equal(toggleNoteOpen(out, 'n.1').notes[0].open, false);
});

test('toggleNoteOpen keeps every note but opens only the one asked for', () => {
  const settings = {
    notes: [
      { id: 'n.1', title: 'a', body: 'x', open: true },
      { id: 'n.2', title: 'b', body: 'y', open: false },
      { id: 'n.3', title: 'c', body: 'z', open: true },
    ],
  };
  const out = toggleNoteOpen(settings, 'n.2');
  assert.deepEqual(out.notes.map((n) => n.open), [false, true, false]);
  assert.deepEqual(out.notes.map((n) => n.body), ['x', 'y', 'z']);
  assert.deepEqual(out.notes.map((n) => n.title), ['a', 'b', 'c']);
});

test('toggleNoteOpen on an id that matches nothing changes nothing', () => {
  const settings = { notes: [{ id: 'n.1', title: 'a', body: 'x', open: false }] };
  assert.deepEqual(toggleNoteOpen(settings, 'n.9').notes, settings.notes);
  assert.deepEqual(toggleNoteOpen({}, 'n.9').notes, []);
});

// --- pronunciation voice ------------------------------------------------------
// The Web Speech API hands us whatever the OS installed. Choosing badly is worse
// than staying silent: an English phrase read by a Spanish voice teaches the wrong
// pronunciation, which is the opposite of what the button is for.

const voice = (name, lang, localService = true) => ({ name, lang, localService });

test('pickEnglishVoice prefers a local voice over a network-backed one', () => {
  const picked = pickEnglishVoice([
    voice('Google US English', 'en-US', false),
    voice('Samantha', 'en-US', true),
  ]);
  assert.equal(picked.name, 'Samantha');
});

test('pickEnglishVoice prefers en-US over another English variant', () => {
  const picked = pickEnglishVoice([voice('Daniel', 'en-GB'), voice('Samantha', 'en-US')]);
  assert.equal(picked.name, 'Samantha');
});

test('pickEnglishVoice accepts any English variant when there is no en-US', () => {
  const picked = pickEnglishVoice([voice('Karen', 'en-AU'), voice('Mónica', 'es-ES')]);
  assert.equal(picked.name, 'Karen');
});

test('pickEnglishVoice falls back to a network voice when no local English exists', () => {
  const picked = pickEnglishVoice([
    voice('Mónica', 'es-ES', true),
    voice('Google UK English', 'en-GB', false),
  ]);
  assert.equal(picked.name, 'Google UK English');
});

test('pickEnglishVoice returns null when no English voice is installed', () => {
  assert.equal(pickEnglishVoice([voice('Mónica', 'es-ES'), voice('Jorge', 'es-MX')]), null);
});

test('pickEnglishVoice survives an empty or malformed voice list', () => {
  assert.equal(pickEnglishVoice([]), null);
  assert.equal(pickEnglishVoice(), null);
  assert.equal(pickEnglishVoice([{}, null, { lang: 'en-US', name: 'ok' }]).name, 'ok');
});

test('pickEnglishVoice is not fooled by a language that merely starts with en', () => {
  assert.equal(pickEnglishVoice([voice('Enya', 'eng-X'), voice('Mónica', 'es-ES')]), null);
});

test('every resolved phrase carries the category it was catalogued under', () => {
  const out = resolvePhrases({ phraseIds: ['time.second', 'clarify.repeat'] });
  assert.deepEqual(out.map((p) => p.cat), ['Ganar tiempo', 'Pedir aclaración']);
});

test('a custom phrase lands in its own category instead of having none', () => {
  const out = resolvePhrases({ phraseIds: [], customPhrases: [{ id: 'u.1', en: 'Ship it,', es: 'a producción' }] });
  assert.deepEqual(out.map((p) => p.cat), [CUSTOM_CAT]);
});

test('phraseCategories keeps phrase order and never repeats a category', () => {
  const cats = phraseCategories(resolvePhrases({
    phraseIds: ['time.second', 'clarify.repeat', 'time.think'],
    customPhrases: [{ id: 'u.1', en: 'Ship it,', es: 'a producción' }],
  }));
  assert.deepEqual(cats, ['Ganar tiempo', 'Pedir aclaración', CUSTOM_CAT]);
});

test('phraseCategories on nothing returns nothing rather than one empty category', () => {
  assert.deepEqual(phraseCategories([]), []);
  assert.deepEqual(phraseCategories(), []);
});

test('opening a note closes whichever one was open', () => {
  const settings = { notes: [{ id: 'a', title: 'a', open: true }, { id: 'b', title: 'b' }] };
  assert.deepEqual(toggleNoteOpen(settings, 'b').notes.map((n) => n.open), [false, true]);
});

test('toggling the open note closes it and leaves the rest closed', () => {
  const settings = { notes: [{ id: 'a', title: 'a', open: true }, { id: 'b', title: 'b' }] };
  assert.deepEqual(toggleNoteOpen(settings, 'a').notes.map((n) => n.open), [false, false]);
});

test('addNote appends an open note and closes the others', () => {
  const before = { notes: [{ id: 'n.1', title: 'Daily', body: 'x', open: true }] };
  const after = addNote(before, { title: 'Salary', body: 'Ask about the band.' });
  assert.equal(after.notes.length, 2);
  assert.equal(after.notes[0].open, false);
  assert.deepEqual({ title: after.notes[1].title, body: after.notes[1].body, open: after.notes[1].open },
    { title: 'Salary', body: 'Ask about the band.', open: true });
  assert.ok(after.notes[1].id.startsWith('n.'));
  assert.notEqual(after, before);
  assert.equal(before.notes.length, 1, 'the input is not mutated');
});

test('addNote ignores an empty note and returns the same settings object', () => {
  const before = { notes: [] };
  assert.equal(addNote(before, { title: '   ', body: '' }), before);
});

test('addNote respects the cap and clamps the lengths', () => {
  const full = { notes: Array.from({ length: MAX_NOTES }, (_, i) => ({ id: `n.${i}`, title: 't', body: 'b', open: false })) };
  assert.equal(addNote(full, { title: 'one more', body: '' }), full);
  const long = addNote({ notes: [] }, { title: 'x'.repeat(NOTE_TITLE_MAX + 5), body: 'y'.repeat(NOTE_BODY_MAX + 5) });
  assert.equal(long.notes[0].title.length, NOTE_TITLE_MAX);
  assert.equal(long.notes[0].body.length, NOTE_BODY_MAX);
});
