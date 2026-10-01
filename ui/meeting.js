// The meeting screen: capture, segment, label, transcribe and translate a live
// conversation into «Yo / Interlocutor» bubbles. Recording starts the moment this
// screen mounts — there is no separate "ready" step once enrollment is done — and
// stays mounted for the whole meeting: app.js overlays settings on top of it
// instead of tearing it down (see app.js), so `settings` here is the very same
// object the overlay edits, and a key/language/translation change reaches the
// next Groq call with no restart. Only app.js's cleanup() (the two print-
// dependent settings actions, or real navigation away) fully tears this down.

import { createSession } from '../session.js';
import { createSpeakers } from '../speaker.js';
import { startCapture } from '../capture.js';
import { transcribeGroq } from '../transcribe.js';
import { toSpanish } from '../translate.js';
import { liveAvailability, startLive } from '../lib/live.js';
import { foldTranslation, nearBottom, shouldPersist } from '../bubbles.js';
import { MODEL_ID } from '../embed.js';
import * as store from '../store.js';

// transcribeGroq's own fetch carries a 30 s AbortSignal.timeout, so a stalled
// request settles on its own; this is the backstop that keeps "Terminar" from
// hanging if session.drain() is waiting on something that does not.
const DRAIN_TIMEOUT_MS = 35000;

// A Web Speech recogniser hears one language. 'multi' (bilingual) meetings hide
// the live line entirely rather than mis-recognising whichever half it guesses
// wrong — the same call the extension makes. Read fresh on every (re)start, so
// a language change from the settings overlay takes effect next time the line
// is (re)started, without needing to restart the meeting itself.
function liveLangFor(lang) {
  if (lang === 'multi') return null;
  return lang === 'es' ? 'es-ES' : 'en-US';
}

function createEmbedClient(worker) {
  let seq = 0;
  const pending = new Map();
  worker.addEventListener('message', ({ data }) => {
    if (data.id === undefined) return;
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.type === 'vector') p.resolve(data.vector);
    else if (data.type === 'error') p.reject(new Error(data.message));
  });
  return function embed(samples) {
    const id = seq++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const copy = samples.slice();
      worker.postMessage({ type: 'embed', id, samples: copy }, [copy.buffer]);
    });
  };
}

export function renderMeeting(root, { settings, onEvent }) {
  root.textContent = '';

  const section = document.createElement('section');
  section.className = 'screen meeting';

  const transcriptEl = document.createElement('div');
  transcriptEl.className = 'transcript';
  section.append(transcriptEl);

  const liveLineEl = document.createElement('div');
  liveLineEl.className = 'live-line';
  liveLineEl.hidden = true;
  const liveLabel = document.createElement('span');
  liveLabel.className = 'live-label';
  liveLabel.textContent = 'Hablando ahora… ';
  const liveTextEl = document.createElement('span');
  liveTextEl.className = 'live-text';
  liveLineEl.append(liveLabel, liveTextEl);
  section.append(liveLineEl);

  const statusEl = document.createElement('p');
  statusEl.className = 'status';
  statusEl.hidden = true;
  section.append(statusEl);

  const toast = document.createElement('p');
  toast.className = 'toast';
  toast.hidden = true;
  section.append(toast);

  const controls = document.createElement('div');
  controls.className = 'controls';
  const talkBtn = document.createElement('button');
  talkBtn.type = 'button';
  talkBtn.className = 'talk-toggle';
  talkBtn.textContent = 'Estoy hablando';
  talkBtn.setAttribute('aria-pressed', 'false');
  talkBtn.disabled = true;
  const pauseBtn = document.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.textContent = 'Pausar';
  pauseBtn.disabled = true;
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.textContent = 'Terminar';
  stopBtn.disabled = true;
  const newMeetingBtn = document.createElement('button');
  newMeetingBtn.type = 'button';
  newMeetingBtn.className = 'primary';
  newMeetingBtn.textContent = 'Nueva reunión';
  newMeetingBtn.hidden = true;
  controls.append(talkBtn, pauseBtn, stopBtn, newMeetingBtn);
  section.append(controls);

  root.append(section);

  let wakeLockWarning = false;
  function setStatus(text, kind = 'info') {
    wakeLockWarning = false;
    statusEl.textContent = text;
    statusEl.hidden = !text;
    statusEl.className = 'status ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '');
  }

  let toastTimer = null;
  function flashToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 1200);
  }

  // --- Transcript rendering ---------------------------------------------------------
  const cache = new Map(); // t -> { text, es, esStale }
  let restored = []; // entries loaded from a previous, unfinished lastTranscript
  let atBottom = true;

  function stickToBottom() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  transcriptEl.addEventListener('scroll', () => {
    atBottom = nearBottom(transcriptEl.scrollHeight, transcriptEl.scrollTop, transcriptEl.clientHeight);
  });

  function findBubble(t) {
    for (const el of transcriptEl.children) if (Number(el.dataset.t) === t) return el;
    return null;
  }

  function insertByTime(node, t) {
    let ref = null;
    for (let el = transcriptEl.lastElementChild; el; el = el.previousElementSibling) {
      if (Number(el.dataset.t) <= t) break;
      ref = el;
    }
    transcriptEl.insertBefore(node, ref);
  }

  function correctBubble(entry) {
    if (!session) return;
    session.correct(entry.t, entry.speaker === 'me' ? 'them' : 'me');
    flashToast('Corregido');
  }

  function bubbleNode(entry, cacheEntry, interactive) {
    const div = document.createElement('div');
    div.className = 'bubble ' + (entry.speaker === 'me' ? 'me' : 'them');
    div.dataset.t = String(entry.t);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = (entry.speaker === 'me' ? 'Yo' : 'Interlocutor') + ' ';
    const tag = document.createElement('span');
    tag.className = 'lang-tag';
    tag.textContent = entry.lang === 'es' ? 'ES' : 'EN';
    meta.append(tag);

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = entry.text;
    div.append(meta, text);

    if (entry.speaker !== 'me' && entry.lang !== 'es' && settings.translate !== false) {
      const es = document.createElement('span');
      es.className = 'es';
      div.append(es);
      if (cacheEntry.es) {
        es.textContent = cacheEntry.es;
      } else {
        if (cacheEntry.esStale) { es.textContent = cacheEntry.esStale; es.classList.add('stale'); }
        toSpanish(entry.text, { key: settings.groqKey, base: settings.groqBase }).then((txt) => {
          if (!txt || destroyed) return;
          const current = cache.get(entry.t);
          if (!current || current.text !== entry.text) return; // superseded by a newer fold
          current.es = txt;
          delete current.esStale;
          const node = findBubble(entry.t)?.querySelector('.es');
          if (node) { node.textContent = txt; node.classList.remove('stale'); }
          // The translation lands after the bubble was painted and makes it taller:
          // without this the newest line can sit half out of sight when it arrives.
          if (atBottom) stickToBottom();
        });
      }
    }

    // A bubble restored from a previous, unfinished meeting is not in this
    // session's own transcript: session.correct() would silently no-op on it,
    // so it is shown as history rather than offered as correctable.
    if (interactive) div.addEventListener('click', () => correctBubble(entry));
    return div;
  }

  function upsert(entry, { interactive = true } = {}) {
    const next = foldTranslation(cache.get(entry.t), entry.text);
    cache.set(entry.t, next);
    const node = bubbleNode(entry, next, interactive);
    const old = findBubble(entry.t);
    if (old) old.replaceWith(node); else insertByTime(node, entry.t);
    if (atBottom) stickToBottom();
  }

  // finishedAt stays null for every write while the meeting is ongoing (every
  // bubble); "Terminar" is the only caller that passes one, so boot()'s next
  // mount can tell "mid-meeting" apart from "the learner actually ended this".
  // shouldPersist is the defensive half of the stopped guard (handleEvent's
  // own early return is the other): the drain race in "Terminar" does not
  // cancel its loser, so a straggler segment can still call this with no
  // finishedAt well after the meeting was marked finished — refused here even
  // if some future caller forgets to check `stopped` itself first.
  function persistTranscript(finishedAt = null) {
    if (!shouldPersist(stopped, finishedAt)) return;
    const entries = [...restored, ...session.transcript()];
    store.set('lastTranscript', { entries, finishedAt }).catch(() => {});
  }

  // --- Live line ---------------------------------------------------------
  let liveHandle = null;
  let liveAvailable = false;
  let liveToken = 0;

  function setLiveText(text) {
    liveTextEl.textContent = text;
    liveLineEl.hidden = !liveAvailable || !text;
  }

  async function setupLive(track) {
    const token = ++liveToken;
    const lang = liveLangFor(settings.lang);
    if (!lang) return; // bilingual: a single recogniser cannot hear both languages
    const avail = await liveAvailability(lang);
    // The await above can finish after a later pause (or a later setupLive call
    // from a quick pause/resume) already moved on; the token guards against
    // starting a recogniser nobody asked for any more.
    if (destroyed || paused || !running || token !== liveToken) return;
    liveAvailable = avail === 'available';
    if (!liveAvailable) return;
    liveHandle = startLive({
      track,
      lang,
      onText: setLiveText,
      onError: () => { liveAvailable = false; setLiveText(''); },
    });
  }

  function teardownLive() {
    liveToken++; // invalidates any setupLive() still awaiting liveAvailability
    liveHandle?.stop();
    liveHandle = null;
    liveAvailable = false;
    setLiveText('');
  }

  // --- Session wiring ---------------------------------------------------------
  let destroyed = false;
  // Set once "Terminar"'s drain race has settled (drain() won, or the bound
  // did). Distinct from `destroyed` (only cleanup() sets that, on real
  // navigation away): the race does not cancel its loser, so a straggler
  // segment can still resolve well after "Reunión terminada." is on screen.
  // Reset on "Nueva reunión", which starts a fresh session that must accept
  // events again.
  let stopped = false;
  let running = false;
  let paused = false;
  let wakeLock = null;
  let captureHandle = null;
  let session = null;
  let worker = null;
  let embed = null;
  let modelReady = null;

  function setupWorker() {
    worker = new Worker(new URL('../embed-worker.js', import.meta.url), { type: 'module' });
    embed = createEmbedClient(worker);
    modelReady = new Promise((resolve, reject) => {
      const onMsg = ({ data }) => {
        if (data.type === 'ready') { worker.removeEventListener('message', onMsg); resolve(); }
        else if (data.type === 'error' && data.id === undefined) {
          worker.removeEventListener('message', onMsg);
          reject(new Error(data.message));
        }
      };
      worker.addEventListener('message', onMsg);
    });
    worker.postMessage({ type: 'init', base: new URL('../vendor/', import.meta.url).href });
  }
  setupWorker();

  function handleEvent(event) {
    if (destroyed || stopped) return;
    onEvent?.(event);
    if (event.type === 'bubble') {
      upsert(event.entry);
      liveHandle?.reset();
      persistTranscript();
    } else if (event.type === 'error') {
      setStatus(event.text, 'error');
    }
  }

  function warnNoWakeLock() {
    setStatus('La pantalla puede apagarse y cortar el micrófono. Mantén la app abierta.', 'error');
    wakeLockWarning = true;
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) { warnNoWakeLock(); return; }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      if (wakeLockWarning) setStatus(running ? 'Grabando…' : '', 'ok');
      wakeLock.addEventListener('release', () => { if (running) warnNoWakeLock(); });
    } catch {
      warnNoWakeLock();
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible' && running) requestWakeLock();
  }
  document.addEventListener('visibilitychange', onVisibility);

  async function startRecording() {
    try {
      captureHandle = await startCapture({ onSegment: (seg) => session.segment(seg) });
    } catch (err) {
      setStatus(err?.message || String(err), 'error');
      return;
    }
    running = true;
    talkBtn.disabled = false;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
    setStatus('Grabando…', 'ok');
    await requestWakeLock();
    await setupLive(captureHandle.stream.getAudioTracks()[0]);
  }

  async function init() {
    const print = await store.get('print');
    if (destroyed) return;
    if (!print || print.model !== MODEL_ID) {
      setStatus('[huella] Falta tu huella de voz.', 'error');
      return;
    }
    setStatus('Cargando el modelo de voz…');
    try {
      await modelReady;
    } catch (err) {
      if (!destroyed) setStatus(err?.message || String(err), 'error');
      return;
    }
    if (destroyed) return;

    const speakers = createSpeakers(Float32Array.from(print.vector));
    session = createSession({
      embed,
      transcribe: (samples) => transcribeGroq(samples, { key: settings.groqKey, base: settings.groqBase, lang: settings.lang }),
      speakers,
      onEvent: handleEvent,
    });
    await startRecording();
  }

  async function beginMeeting(restoredEntries) {
    restored = restoredEntries;
    for (const entry of restored) upsert(entry, { interactive: false });
    await init();
  }

  function showResumeChooser(saved) {
    const chooser = document.createElement('div');
    chooser.className = 'resume-chooser';
    const p = document.createElement('p');
    p.textContent = 'Tienes una conversación sin terminar.';
    const row = document.createElement('div');
    row.className = 'controls';
    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'primary';
    continueBtn.textContent = 'Continuar';
    const freshBtn = document.createElement('button');
    freshBtn.type = 'button';
    freshBtn.textContent = 'Nueva reunión';
    row.append(continueBtn, freshBtn);
    chooser.append(p, row);
    section.insertBefore(chooser, transcriptEl);

    continueBtn.addEventListener('click', () => {
      chooser.remove();
      beginMeeting(saved);
    });
    freshBtn.addEventListener('click', async () => {
      chooser.remove();
      await store.del('lastTranscript').catch(() => {});
      beginMeeting([]);
    });
  }

  async function boot() {
    const saved = await store.get('lastTranscript');
    if (destroyed) return;
    // Array.isArray: lastTranscript predates the { entries, finishedAt }
    // shape, so a value saved before this change is read as unfinished.
    const entries = Array.isArray(saved) ? saved : saved?.entries;
    const finished = Array.isArray(saved) ? false : !!saved?.finishedAt;
    if (!finished && Array.isArray(entries) && entries.length) showResumeChooser(entries);
    else await beginMeeting([]);
  }
  boot();

  // --- Controls ---------------------------------------------------------
  talkBtn.addEventListener('click', () => {
    const next = talkBtn.getAttribute('aria-pressed') !== 'true';
    talkBtn.setAttribute('aria-pressed', String(next));
    talkBtn.classList.toggle('on', next);
    session?.setManual(next ? 'me' : null);
  });

  pauseBtn.addEventListener('click', () => {
    if (!captureHandle) return;
    paused = !paused;
    captureHandle.pause(paused);
    pauseBtn.textContent = paused ? 'Reanudar' : 'Pausar';
    if (paused) {
      teardownLive();
    } else {
      setupLive(captureHandle.stream.getAudioTracks()[0]);
    }
  });

  stopBtn.addEventListener('click', async () => {
    running = false;
    talkBtn.disabled = true;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
    setStatus('Terminando…');
    teardownLive();
    if (wakeLock) { try { await wakeLock.release(); } catch { /* already gone */ } wakeLock = null; }
    const handle = captureHandle;
    captureHandle = null;
    if (handle) await handle.stop();
    // Pending embeds and Groq calls (including the segment stop() just flushed)
    // are still in flight: wait for every bubble they produce before the worker
    // that embeds them is freed and the screen calls itself finished — bounded,
    // so a stall elsewhere cannot leave "Terminar" on "Terminando…" forever.
    if (session) {
      await Promise.race([session.drain(), new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS))]);
    }
    // The race above does not cancel its loser: once it settles (drain()
    // finished, or the bound did), any segment still resolving afterwards is a
    // straggler. From here on handleEvent ignores it outright (no bubble, no
    // status, no persist), and persistTranscript refuses it too even if that
    // guard is ever bypassed — either way it cannot reopen the meeting this
    // call is about to mark finished.
    stopped = true;
    if (destroyed) return;
    worker.terminate();
    persistTranscript(Date.now()); // finishedAt: a future mount must not offer this as unfinished
    setStatus('Reunión terminada.');
    newMeetingBtn.hidden = false;
  });

  newMeetingBtn.addEventListener('click', async () => {
    newMeetingBtn.hidden = true;
    transcriptEl.textContent = '';
    cache.clear();
    talkBtn.setAttribute('aria-pressed', 'false');
    talkBtn.classList.remove('on');
    pauseBtn.textContent = 'Pausar';
    paused = false;
    stopped = false; // a fresh session must accept events again
    setStatus('');
    await store.del('lastTranscript').catch(() => {});
    setupWorker();
    await beginMeeting([]);
  });

  return function cleanup() {
    destroyed = true;
    running = false;
    document.removeEventListener('visibilitychange', onVisibility);
    clearTimeout(toastTimer);
    teardownLive();
    if (wakeLock) wakeLock.release().catch(() => {});
    if (captureHandle) captureHandle.stop().catch(() => {});
    worker.terminate();
  };
}
