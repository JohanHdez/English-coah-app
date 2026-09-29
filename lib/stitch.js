// Turns a series of overlapping transcriptions into one line that only ever grows
// and only ever changes at its end.
//
// The provisional lane re-transcribes the trailing PREVIEW_TAIL_MS of a phrase
// every PREVIEW_EVERY_MS, so successive passes are overlapping re-transcriptions
// of the same speech, not disjoint pieces to append. Two consequences shape this
// module, and both are why a plain longest-common-prefix rule does not work here:
//
//   - Once a phrase outgrows the window, a pass no longer contains the head of the
//     phrase. Passes stop sharing a starting point, so their common prefix is
//     empty exactly in the case this exists for.
//   - A later pass can revise a word an earlier one produced, anywhere inside the
//     window.
//
// So a pass is aligned by finding where in the accumulated line it starts, and two
// rules decide what is settled. A word is committed when two consecutive passes
// agree on it, or when the pass no longer covers it at all — the window only moves
// forward, so no future pass can ever see that audio again. The second rule is
// what keeps the head of a long phrase on screen, and it also bounds the damage if
// the agreement threshold is set wrong.
//
// The price of that guarantee: a pass that re-reads already committed words
// differently is refused, and if it also re-segments them (two words becoming one)
// the positional mapping past that point shifts by the difference. It is bounded —
// committing needs two passes to agree first, so a late re-reading of settled text
// is rare — and the alternative is text mutating behind someone who is reading it.

// One word in common is not an alignment: a filler like "it" appears everywhere,
// and splicing two unrelated stretches together on that evidence reads as fluent
// nonsense, which is worse than a visible gap.
const MIN_OVERLAP = 2;

export const EMPTY = Object.freeze({ line: [], committed: 0, previous: [] });

// Matching ignores what does not change a word: Whisper varies capitalisation and
// trailing punctuation between passes over the same audio.
const norm = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

const same = (a, b) => norm(a) === norm(b);

// How many words of `pass` match `line` starting at index `start`.
function runFrom(line, pass, start) {
  let n = 0;
  while (start + n < line.length && n < pass.length && same(line[start + n], pass[n])) n++;
  return n;
}

// Where in the accumulated line this pass begins. The longest run wins; ties go to
// the latest position, because the window moves forward and never back.
function alignAt(line, pass) {
  let best = -1;
  let bestRun = 0;
  for (let start = 0; start < line.length; start++) {
    const run = runFrom(line, pass, start);
    if (run >= bestRun && run > 0) { best = start; bestRun = run; }
  }
  return bestRun >= Math.min(MIN_OVERLAP, line.length) && bestRun > 0 ? best : -1;
}

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && same(a[n], b[n])) n++;
  return n;
}

const view = (state) => ({
  state,
  committed: state.line.slice(0, state.committed).join(' '),
  tail: state.line.slice(state.committed).join(' '),
});

// Pure: state in, state out. The offscreen document holds one of these per phrase
// and drops it when the segmenter flushes, so a new phrase cannot inherit the
// previous one's prefix.
export function stitch(state = EMPTY, text = '') {
  const pass = words(text);
  if (!pass.length) return view(state);

  const { line, committed, previous } = state;
  const at = line.length ? alignAt(line, pass) : 0;

  let merged;
  let settled = committed;

  if (at < 0) {
    // Nothing in this pass lines up with what is on screen. Keeping the committed
    // text and letting the pass stand as the tail may briefly show a word twice;
    // blanking a line someone is reading is worse, and unrecoverable.
    merged = line.slice(0, committed).concat(pass);
  } else {
    // Words before the pass begins are outside the window for good.
    const keep = Math.max(committed, at);
    merged = line.slice(0, keep).concat(pass.slice(keep - at));
    settled = Math.max(settled, at);
  }

  // ...and words two consecutive passes agreed on.
  settled = Math.max(settled, commonPrefix(merged, previous));

  return view({ line: merged, committed: Math.min(settled, merged.length), previous: merged });
}
