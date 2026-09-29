import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY, stitch } from './stitch.js';

// Feeds successive preview passes through the stitcher and returns the last view
// plus every intermediate one, the way the offscreen document would.
function run(passes, state = EMPTY) {
  const views = [];
  for (const p of passes) {
    const out = stitch(state, p);
    state = out.state;
    views.push({ committed: out.committed, tail: out.tail });
  }
  return { views, last: views[views.length - 1], state };
}

test('the first pass commits nothing: one hypothesis is not agreement', () => {
  const { last } = run(['hello world how']);
  assert.equal(last.committed, '');
  assert.equal(last.tail, 'hello world how');
});

test('what two consecutive passes agree on is committed', () => {
  const { last } = run(['hello world how', 'hello world how are']);
  assert.equal(last.committed, 'hello world how');
  assert.equal(last.tail, 'are');
});

test('the committed prefix never shrinks or changes as passes arrive', () => {
  const { views } = run([
    'so the thing about',
    'so the thing about memo',
    'so the thing about memo is',
    'so the thing about memo is that',
  ]);
  const committed = views.map((v) => v.committed);
  for (let i = 1; i < committed.length; i++) {
    assert.ok(committed[i].startsWith(committed[i - 1]),
      `"${committed[i]}" does not extend "${committed[i - 1]}"`);
  }
});

// The coverage hole: past PREVIEW_TAIL_MS a pass no longer contains the head of
// the phrase. The head must stay on screen rather than falling off it.
test('text whose audio left the window stays committed', () => {
  const { last } = run([
    'the australian military declared war on emus',
    'the australian military declared war on emus because',
    // the window has slid: this pass no longer carries "the australian"
    'military declared war on emus because the birds',
    'declared war on emus because the birds were destroying',
  ]);
  assert.ok(last.committed.startsWith('the australian military'),
    `head fell off the line: "${last.committed}"`);
  assert.ok((last.committed + ' ' + last.tail).includes('birds'));
});

test('a sliding window does not duplicate the overlap', () => {
  const { last } = run([
    'one two three four five',
    'two three four five six',
    'three four five six seven',
  ]);
  const whole = (last.committed + ' ' + last.tail).trim();
  assert.equal(whole, 'one two three four five six seven');
});

test('a word the speaker really repeated is not collapsed into one', () => {
  const { last } = run(['that is very very', 'that is very very good']);
  const whole = (last.committed + ' ' + last.tail).trim();
  assert.equal(whole, 'that is very very good');
});

// If Whisper returns something that shares no boundary with what is already on
// screen, the safe move is to keep what was committed. Dropping it would blank a
// line the learner is in the middle of reading.
test('a pass that does not align keeps the committed text instead of dropping it', () => {
  const { last } = run([
    'we need to figure out',
    'we need to figure out how',
    'completely unrelated words appear',
  ]);
  assert.equal(last.committed, 'we need to figure out');
  assert.equal(last.tail, 'completely unrelated words appear');
});

test('alignment ignores case and trailing punctuation', () => {
  const { last } = run([
    'i think so',
    'I think so, yes',
    'think so, yes it is',
  ]);
  const whole = (last.committed + ' ' + last.tail).trim().toLowerCase();
  assert.ok(whole.includes('i think so'), whole);
  assert.ok(whole.endsWith('yes it is'), whole);
});

// flush() empties the segmenter's buffer at every cut, so the next phrase starts
// from nothing. Without this the new phrase inherits the previous one's prefix.
test('a fresh state starts empty so a new phrase cannot inherit the last one', () => {
  const { state } = run(['one two three', 'one two three four']);
  assert.notEqual(state, EMPTY);
  const { last } = run(['completely new phrase'], EMPTY);
  assert.equal(last.committed, '');
  assert.equal(last.tail, 'completely new phrase');
});

test('empty and whitespace-only passes never disturb what is committed', () => {
  const { last } = run(['one two three', 'one two three four', '', '   ']);
  assert.equal(last.committed, 'one two three');
  assert.equal(last.tail, 'four');
});

test('a one-word overlap is too weak to align on', () => {
  // "it" appears in both but means a different moment; committing on that alone
  // would splice two unrelated stretches together.
  const { last } = run([
    'i really like it',
    'i really like it',
    'it is getting late',
  ]);
  assert.equal(last.committed, 'i really like it');
  assert.equal(last.tail, 'it is getting late');
});

// The reason a plain suffix/prefix match is not enough: Whisper revises words it
// already produced, and a revision inside the still-unsettled tail must be applied
// rather than read as a failure to align.
test('a revision in the unsettled tail is applied, not treated as a failed alignment', () => {
  const { last } = run([
    'the cost of tracking',
    'the cost of tracking dependencies',
    // "dependencies" turns out to be "dependence": a revision inside the overlap
    'the cost of tracking dependence can',
  ]);
  assert.equal(last.committed, 'the cost of tracking');
  assert.equal(last.tail, 'dependence can');
});

// The other side of the same guarantee, and the price of it: once two passes have
// agreed on a word it is settled, so a later pass that re-reads it differently is
// refused. Text that has stopped moving must stay stopped.
test('a revision of already committed text is refused', () => {
  const { last } = run([
    'we could use a memo hook',
    'we could use a memo hook here',
    'could use useMemo hook here instead',
  ]);
  assert.ok(last.committed.startsWith('we could use a memo hook'),
    `committed text was rewritten: "${last.committed}"`);
});

test('a word already committed is never rewritten by a later pass', () => {
  const { views } = run([
    'the birds were destroying crops',
    'the birds were destroying crops badly',
    'birds were ruining crops badly indeed',
  ]);
  const committed = views.map((v) => v.committed);
  for (let i = 1; i < committed.length; i++) {
    assert.ok(committed[i].startsWith(committed[i - 1]),
      `"${committed[i]}" rewrote "${committed[i - 1]}"`);
  }
});
