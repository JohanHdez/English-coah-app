import test from 'node:test';
import assert from 'node:assert/strict';
import { detect } from './langid.js';

// Utterances shaped like the ones a real bilingual meeting produces.
const CASES = [
  ['en', 'So I think we should move the deadline to next Friday, if that works for everyone.'],
  ['es', 'Yo creo que deberíamos mover la fecha para el viernes, si les parece bien.'],
  ['en', 'Can you share the document with the team before the call?'],
  ['es', '¿Puedes compartir el documento con el equipo antes de la llamada?'],
  ['es', 'Perdón, se me cortó el audio. ¿Me escuchan ahora?'],
  ['en', 'Yeah, no worries, we can hear you now.'],
  ['es', 'Necesito más tiempo para hacer el reporte de ventas.'],
  ['en', 'Let me check the numbers and get back to you tomorrow.'],
];

test('it reads ordinary meeting sentences in both languages', () => {
  for (const [expected, text] of CASES) {
    assert.equal(detect(text).lang, expected, text);
  }
});

test('a bare acknowledgement is still readable', () => {
  // These are most of what a meeting transcript is made of, and a wrong guess on
  // one of them switches a speaker's language for the turns that follow.
  for (const [expected, text] of [['en', 'Okay.'], ['en', 'Thanks.'], ['es', 'Sí.'], ['es', 'Gracias.']]) {
    assert.equal(detect(text).lang, expected, text);
  }
});

test('shared jargon with no evidence returns no answer rather than a guess', () => {
  // Naming a language here would flip a speaker on the strength of nothing.
  for (const text of ['Marketing, software, cloud, dashboard, feedback.', '', '   ', '...']) {
    const out = detect(text);
    assert.equal(out.lang, null, JSON.stringify(text));
    assert.equal(out.confidence, 0);
  }
});

test('an English sentence keeps its language when a Spanish name appears in it', () => {
  // The reason accent weight is scaled by length instead of being a flat bonus:
  // one accented proper noun used to outvote four English function words.
  assert.equal(detect('We visited España last year and it was great.').lang, 'en');
  assert.equal(detect('The client is José and he works with the team.').lang, 'en');
});

test('Spanish survives English loanwords in the middle of it', () => {
  assert.equal(detect('El dashboard de marketing no carga el feedback.').lang, 'es');
});

test('confidence is high when the evidence is one-sided and low when it is mixed', () => {
  assert.equal(detect('Yo creo que la fecha es el viernes.').confidence, 1);
  const mixto = detect('We visited España last year and it was great.');
  assert.ok(mixto.confidence > 0 && mixto.confidence < 1,
    `mixed evidence should not read as certain, got ${mixto.confidence}`);
});
