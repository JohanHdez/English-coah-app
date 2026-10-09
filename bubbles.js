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

// Ties each transcription session's events to the meeting that produced it.
// "Terminar"'s drain race does not cancel its loser, so a segment backed up
// behind MAX_INFLIGHT can resolve after the meeting ended — or after "Nueva
// reunión" started another one. Each session's handler is bound to the
// generation current when it was created; close() ("Terminar") and every
// later bind() ("Nueva reunión") move the generation on, so an event from an
// earlier session is dropped instead of painting a stale bubble or error into
// the new meeting, or clearing the finishedAt marker "Terminar" wrote.
export function createMeetingGate() {
  let current = 0;
  return {
    bind(handler) {
      const gen = ++current;
      return (event) => { if (gen === current) handler(event); };
    },
    close() { current++; },
  };
}

// One task at a time, in call order; a failing task does not stop the next. On a
// phone (no built-in Translator) every translation is a Groq chat request, and
// Groq's free tier caps requests per minute.
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

// The transcript as stored: each entry carries the Spanish shown under it, so a
// meeting continued later paints it without asking for it again. A translation of
// words the bubble no longer holds is left out.
export function withTranslations(entries, cache) {
  return entries.map((entry) => {
    const cached = cache.get(entry.t);
    if (cached?.es && cached.text === entry.text) return { ...entry, es: cached.es };
    return entry;
  });
}

// A capture finishes opening asynchronously (permission prompt, context resume).
// «Terminar» and «Nueva reunión» each move the epoch on, so a microphone that
// was requested before either arrives stale and must be released, not installed.
export function mayInstallCapture({ destroyed, epoch, currentEpoch }) {
  return !destroyed && epoch === currentEpoch;
}
