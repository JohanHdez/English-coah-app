// Pure helpers for the meeting transcript view, factored out of the DOM so they
// run under node --test: which Spanish translation to show while a changed bubble
// is retranslated (ported from the extension's addEntry, sidepanel.js at ded2c34),
// and whether the view sits close enough to the foot of the scroll container that
// a new bubble should keep pulling it down (the extension's nearBottom).

// A bubble re-sent with the same words keeps its cached Spanish translation; one
// whose words changed is queued for retranslation, but keeps showing the previous
// Spanish — marked stale — rather than a blank line under text the reader is in
// the middle of reading.
export function foldTranslation(prev, text) {
  if (!prev) return { text };
  if (prev.text === text) return { text, es: prev.es, esStale: prev.esStale };
  if (prev.es || prev.esStale) return { text, esStale: prev.es || prev.esStale };
  return { text };
}

export function nearBottom(scrollHeight, scrollTop, clientHeight, thresholdPx = 48) {
  return scrollHeight - scrollTop - clientHeight < thresholdPx;
}

// Whether a lastTranscript write should proceed, once ui/meeting.js's
// "Terminar" has committed to ending the meeting (`stopped`, set after the
// drain race against session.drain() settles — win or bound). The drain race
// does not cancel its loser: a segment backed up behind MAX_INFLIGHT can still
// resolve after the 35 s bound already fired and "Reunión terminada." is on
// screen. Without this, that straggler's ordinary in-progress save
// (finishedAt: null, the default) would silently clear the finishedAt marker
// Terminar already wrote, reopening a meeting the learner explicitly ended —
// exactly the bug the finishedAt marker exists to prevent. The official
// Terminar write itself always carries its own finishedAt and is never refused.
export function shouldPersist(stopped, finishedAt) {
  return !stopped || finishedAt !== null;
}
