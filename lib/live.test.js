import test from 'node:test';
import assert from 'node:assert/strict';

// live.js reads the recogniser constructor once, at import: the fake has to be in
// place before the module loads. It never listens; the tests feed it results.
class FakeRecognition {
  static last = null;
  constructor() { FakeRecognition.last = this; this.started = false; this.stopped = false; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
globalThis.SpeechRecognition = FakeRecognition;
const { startLive } = await import('./live.js');

const result = (transcript, isFinal) => Object.assign([{ transcript }], { isFinal });
const results = (...rs) => ({ results: rs });

function open() {
  const shown = [];
  const live = startLive({ track: {}, onText: (t) => shown.push(t) });
  return { live, rec: FakeRecognition.last, shown };
}

test('the line shows the interim result word by word', () => {
  const { rec, shown } = open();
  rec.onresult(results(result('okay so', false)));
  rec.onresult(results(result('okay so just a warning', false)));
  assert.deepEqual(shown, ['okay so', 'okay so just a warning']);
});

test('a reset mid-utterance keeps showing the words spoken after it', () => {
  // The other speaker never pauses: the recogniser holds one growing interim
  // result for the whole monologue. Whisper's forced cut lands a turn eight
  // seconds in and resets the line; the words already in that bubble must go,
  // the words still being said must not.
  const { live, rec, shown } = open();
  rec.onresult(results(result('okay so just a warning', false)));
  live.reset();
  assert.equal(shown.at(-1), '', 'the reset blanks the line: its words are in the bubble now');
  rec.onresult(results(result('okay so just a warning I might ramble', false)));
  assert.equal(shown.at(-1), 'I might ramble');
  rec.onresult(results(result('okay so just a warning I might ramble a little', false)));
  assert.equal(shown.at(-1), 'I might ramble a little');
});

test('after the reset, a finalised utterance and the next interim read as one line', () => {
  const { live, rec, shown } = open();
  rec.onresult(results(result('okay so just a warnin', false)));
  live.reset();
  // The final may respell the interim it replaces: the cut still lands on a word.
  rec.onresult(results(result('Okay, so just a warning I might ramble', true), result(' it makes me', false)));
  assert.equal(shown.at(-1), 'I might ramble it makes me');
});

test('a revision shorter than what the bubble holds shows nothing rather than repeating it', () => {
  const { live, rec, shown } = open();
  rec.onresult(results(result('okay so just a warning', false)));
  live.reset();
  rec.onresult(results(result('okay so just a', false)));
  assert.equal(shown.at(-1), '');
});

test('a reset after finalised results skips exactly those', () => {
  const { live, rec, shown } = open();
  rec.onresult(results(result('first sentence.', true), result(' second', false)));
  rec.onresult(results(result('first sentence.', true), result(' second sentence.', true)));
  live.reset();
  rec.onresult(results(result('first sentence.', true), result(' second sentence.', true), result(' third', false)));
  assert.equal(shown.at(-1), 'third');
});

test('a restarted recogniser starts from nothing', async () => {
  const { live, rec, shown } = open();
  rec.onresult(results(result('okay so just a warning', false)));
  live.reset();
  rec.onend();
  await new Promise((r) => setTimeout(r, 350));
  const next = FakeRecognition.last;
  assert.notEqual(next, rec, 'onend relaunches');
  next.onresult(results(result('a new utterance', false)));
  assert.equal(shown.at(-1), 'a new utterance');
  live.stop();
});
