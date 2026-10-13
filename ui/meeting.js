// The meeting screen: capture, segment, label, transcribe and translate a live
// conversation into «Yo / Interlocutor» bubbles. Recording starts on a tap
// («Empezar reunión», «Continuar» or «Nueva reunión»): browsers only run an
// AudioContext created during a user gesture. The screen stays mounted for the
// whole meeting: app.js overlays settings on top of it
// instead of tearing it down (see app.js), so `settings` here is the very same
// object the overlay edits, and a provider/key/language/translation change
// reaches the next call with no restart. Only app.js's cleanup() (the two print-
// dependent settings actions, or real navigation away) fully tears this down.

import { createSession } from '../session.js';
import { createSpeakers } from '../speaker.js';
import { startCapture, createAudioContext } from '../capture.js';
import { transcribe } from '../transcribe.js';
import { toSpanish, liveTranslation } from '../translate.js';
import { createLiveTranslator } from '../live-translate.js';
import { liveAvailability, installLive, startLive } from '../lib/live.js';
import { liveMode, createPreviewLane, NOTES, isMobile, deviceFacts, previewEnabled } from '../live-lane.js';
import { foldTranslation, nearBottom, createMeetingGate, createSerialQueue, withTranslations, mayInstallCapture, STALL_CHECK_MS } from '../bubbles.js';
import { MODEL_ID } from '../embed.js';
import * as store from '../store.js';
import { createCoachPanel } from './coach.js';
import { createReportPanel } from './report.js';

// The transcription fetch (providers.js) carries a 30 s AbortSignal.timeout, so a stalled
// request settles on its own; this is the backstop that keeps "Terminar" from
// hanging if session.drain() is waiting on something that does not. When it
// expires the session is closed: no meeting audio is uploaded after «Terminar».
const DRAIN_TIMEOUT_MS = 35000;

const CAPTURE_LOST = '[micrófono] La captura se detuvo mientras la app estaba en segundo plano.';
const CAPTURE_STALLED = '[micrófono] La captura se detuvo: hace unos segundos que no llega audio del micrófono.';

// A Web Speech recogniser hears one language. 'multi' (bilingual) meetings get no
// live line, and a note saying why, rather than mis-recognising whichever half it
// guesses wrong — the same call the extension makes. Read fresh on every (re)start, so
// a language change from the settings overlay takes effect next time the line
// is (re)started, without needing to restart the meeting itself.
function liveLangFor(lang) {
  if (lang === 'multi') return null;
  return lang === 'es' ? 'es-ES' : 'en-US';
}

// A worker that dies (out of memory on a phone) answers nothing: without a bound
// the label chain would wait forever while uploads kept sending audio. The bound
// is on the worker's silence, not on each call, because calls queue behind each
// other in the worker and a backlog is not a crash; a single embedding takes
// well under a second per second of speech.
const EMBED_SILENCE_MS = 15000;

// `timings` (loopback harness only) receives each embedding's round trip.
function createEmbedClient(worker, timings) {
  let seq = 0;
  const pending = new Map();
  let watchdog = null;
  function failAll(message) {
    clearTimeout(watchdog);
    watchdog = null;
    const waiting = [...pending.values()];
    pending.clear();
    for (const p of waiting) p.reject(new Error(message));
  }
  function arm() {
    clearTimeout(watchdog);
    watchdog = pending.size ? setTimeout(() => failAll('[huella] El modelo de voz no respondió a tiempo.'), EMBED_SILENCE_MS) : null;
  }
  worker.addEventListener('message', ({ data }) => {
    if (data.id === undefined) return;
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    arm();
    if (data.type === 'vector') p.resolve(data.vector);
    else if (data.type === 'error') p.reject(new Error(data.message));
  });
  worker.addEventListener('error', (event) => {
    failAll(`[huella] El modelo de voz se detuvo: ${event.message || 'error del worker'}.`);
  });
  return function embed(samples) {
    const id = seq++;
    const t0 = performance.now();
    const seconds = samples.length / 16000;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => { timings?.push({ ms: performance.now() - t0, seconds }); resolve(v); },
        reject,
      });
      if (pending.size === 1) arm();
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

  const liveEsEl = document.createElement('div');
  liveEsEl.className = 'live-line live-es';
  liveEsEl.hidden = true;
  liveEsEl.lang = 'es';
  const liveEsText = document.createElement('span');
  liveEsText.className = 'live-text';
  liveEsEl.append(liveEsText);
  section.append(liveEsEl);

  const liveNoteEl = document.createElement('p');
  liveNoteEl.className = 'live-note';
  liveNoteEl.hidden = true;
  const liveNoteText = document.createElement('span');
  const installBtn = document.createElement('button');
  installBtn.type = 'button';
  installBtn.className = 'install-live';
  installBtn.textContent = 'Instalar reconocimiento de voz';
  installBtn.hidden = true;
  liveNoteEl.append(liveNoteText, installBtn);
  section.append(liveNoteEl);

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
  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'primary reply-btn';
  replyBtn.textContent = 'Respuesta';
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'primary start-meeting';
  startBtn.textContent = 'Empezar reunión';
  startBtn.hidden = true;
  const resumeBtn = document.createElement('button');
  resumeBtn.type = 'button';
  resumeBtn.className = 'primary resume-capture';
  resumeBtn.textContent = 'Reanudar';
  resumeBtn.hidden = true;
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
  stopBtn.className = 'stop-meeting';
  stopBtn.textContent = 'Terminar';
  stopBtn.disabled = true;
  const newMeetingBtn = document.createElement('button');
  newMeetingBtn.type = 'button';
  newMeetingBtn.className = 'primary new-meeting';
  newMeetingBtn.textContent = 'Nueva reunión';
  newMeetingBtn.hidden = true;
  const reportBtn = document.createElement('button');
  reportBtn.type = 'button';
  reportBtn.className = 'primary report-btn';
  reportBtn.textContent = 'Generar informe';
  reportBtn.hidden = true;
  controls.append(replyBtn, startBtn, resumeBtn, talkBtn, pauseBtn, stopBtn, reportBtn, newMeetingBtn);
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

  const coach = createCoachPanel({
    settings,
    getTurns: () => [...restored, ...(session ? session.transcript() : [])],
    getLive: () => (liveLineEl.hidden ? '' : liveTextEl.textContent),
    onToast: flashToast,
    onLayout: () => { if (atBottom) stickToBottom(); },
    onBusy: (busy) => { replyBtn.disabled = busy; replyBtn.classList.toggle('busy', busy); },
  });
  section.insertBefore(coach.el, transcriptEl);
  replyBtn.addEventListener('click', () => coach.ask());

  let reportMd = null; // the last report, stored with the transcript
  const report = createReportPanel({
    settings,
    getTurns: () => [...restored, ...(session ? session.transcript() : [])],
    getDocuments: () => store.listDocuments(),
    onToast: flashToast,
    onBusy: (busy) => { reportBtn.disabled = busy; reportBtn.classList.toggle('busy', busy); },
    onReport: (text) => { reportMd = text; persistTranscript(); },
  });
  section.insertBefore(report.el, controls);
  reportBtn.addEventListener('click', () => report.generate());

  // --- Transcript rendering ---------------------------------------------------------
  const cache = new Map(); // t -> { text, es, esStale }
  let restored = []; // entries loaded from a previous, unfinished lastTranscript
  let atBottom = true;
  const translateQueue = createSerialQueue();

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
        // A fold that lands while this waits supersedes it: by its turn the
        // check below skips it, and only the newest words are sent.
        const isCurrent = () => {
          const current = cache.get(entry.t);
          return !destroyed && current && current.text === entry.text && !current.es;
        };
        translateQueue(() => (isCurrent() ? toSpanish(entry.text, settings) : '')).then((txt) => {
          if (!txt || !isCurrent()) return;
          const current = cache.get(entry.t);
          current.es = txt;
          delete current.esStale;
          const node = findBubble(entry.t)?.querySelector('.es');
          if (node) { node.textContent = txt; node.classList.remove('stale'); }
          // The translation lands after the bubble was painted and makes it taller:
          // without this the newest line can sit half out of sight when it arrives.
          if (atBottom) stickToBottom();
          persistTranscript();
        }, () => {});
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

  // finishedAt stays null while the meeting is ongoing; "Terminar" is the only
  // place that sets it, so boot()'s next mount can tell "mid-meeting" apart from
  // "the learner actually ended this" — and a translation landing after
  // "Terminar" re-persists without reopening the meeting.
  let finishedAt = null;
  // Set by «Borrar la conversación guardada»: a translation or a report that lands
  // afterwards must not write the deleted conversation back.
  let forgotten = false;
  function persistTranscript() {
    if (forgotten) return;
    const entries = withTranslations([...restored, ...(session ? session.transcript() : [])], cache);
    store.set('lastTranscript', reportMd ? { entries, finishedAt, report: reportMd } : { entries, finishedAt }).catch(() => {});
  }

  // --- Live line ---------------------------------------------------------
  // On-device Web Speech where the browser has it; otherwise, on a device with
  // WebGPU, a local Whisper preview of the phrase still being spoken. Neither ever
  // falls back to a cloud recogniser, and when neither runs the screen says why.
  let liveHandle = null;
  let previewLane = null;
  let previewWorker = null;
  let previewReady = null;
  let previewSeq = 0;
  const previewPending = new Map();
  let liveAvailable = false;
  let liveToken = 0;
  let installing = false;
  // Retired for the rest of this meeting: a lane rebuilt after a pause would be
  // just as slow on the same device.
  let previewRetired = false;
  const mobile = isMobile(deviceFacts(globalThis));

  function setLiveText(text) {
    liveTextEl.textContent = text;
    liveLineEl.hidden = !liveAvailable || !text;
    onEvent?.({ type: 'live', text: liveLineEl.hidden ? '' : text });
    followLive(liveLineEl.hidden ? '' : text);
  }

  // The Spanish under the live line: provisional like the line itself, never
  // stored; the bubble brings the translation that stays.
  let liveTr = null;
  let liveTrReady = null;
  let liveTrText = '';

  function setLiveEs(text) {
    liveEsText.textContent = text;
    liveEsEl.hidden = !text;
    onEvent?.({ type: 'live-es', text });
  }

  function followLive(text) {
    liveTrText = text;
    if (!text || settings.translate === false || liveLangFor(settings.lang) !== 'en-US') {
      liveTr?.clear();
      setLiveEs('');
      return;
    }
    if (liveTr) { liveTr.update(text); return; }
    liveTrReady ??= liveTranslation(settings).then(({ translate, sentences, gapMs }) => {
      if (destroyed) return;
      liveTr = createLiveTranslator({ translate, sentences, gapMs, onText: setLiveEs });
      if (liveTrText) liveTr.update(liveTrText);
    }).catch(() => {});
  }

  function setLiveNote(text, { install = false } = {}) {
    liveNoteText.textContent = text ? text + ' ' : '';
    installBtn.hidden = !install;
    liveNoteEl.hidden = !text && !install;
  }

  function loadPreview() {
    if (previewReady) return previewReady;
    previewWorker = new Worker(new URL('../preview-worker.js', import.meta.url), { type: 'module' });
    previewReady = new Promise((resolve, reject) => {
      previewWorker.addEventListener('message', ({ data }) => {
        if (data.id !== undefined) {
          const p = previewPending.get(data.id);
          previewPending.delete(data.id);
          if (data.type === 'result') p?.resolve(data.text);
          else p?.reject(new Error(data.message));
        } else if (data.type === 'ready') resolve(data.device);
        else if (data.type === 'error') reject(new Error(data.message));
      });
    });
    previewReady.catch(() => {});
    previewWorker.postMessage({ type: 'init', base: new URL('../vendor/', import.meta.url).href, model: window.__ec?.previewModel });
    return previewReady;
  }

  function previewTranscribe(audio) {
    const id = previewSeq++;
    const t0 = performance.now();
    const seconds = audio.length / 16000;
    return new Promise((resolve, reject) => {
      previewPending.set(id, {
        resolve: (text) => { window.__ec?.previews.push({ ms: performance.now() - t0, seconds }); resolve(text); },
        reject,
      });
      previewWorker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
    });
  }

  function dropPreviewWorker() {
    previewWorker?.terminate();
    previewWorker = null;
    previewReady = null;
    for (const p of previewPending.values()) p.reject(new Error('stopped'));
    previewPending.clear();
  }

  async function hasWebGPU() {
    try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; }
  }

  // Started with the meeting rather than with the recording, so the model and its
  // shaders are ready by the first sentence: loaded after capture began, the lane
  // was measured ready 7.3 s in, the first three sentences blank.
  async function preloadPreview() {
    const lang = liveLangFor(settings.lang);
    if (!previewEnabled(settings.livePreview, mobile) || previewRetired || !lang) return;
    const availability = await liveAvailability(lang);
    const webgpu = await hasWebGPU();
    if (destroyed || stopping || finishedAt || previewRetired) return;
    if (liveMode({ lang, availability, webgpu, preview: settings.livePreview, mobile }).kind !== 'preview') return;
    loadPreview();
  }

  async function setupLive(track) {
    const token = ++liveToken;
    const lang = liveLangFor(settings.lang);
    const availability = lang ? await liveAvailability(lang) : null;
    const needsGpu = lang && availability !== 'available' && availability !== 'downloadable' && availability !== 'downloading';
    const webgpu = needsGpu ? await hasWebGPU() : false;
    // The awaits above can finish after a later pause (or a later setupLive call
    // from a quick pause/resume) already moved on; the token guards against
    // starting a recogniser nobody asked for any more.
    if (destroyed || paused || !running || token !== liveToken) return;
    const mode = liveMode({ lang, availability, webgpu, preview: settings.livePreview, mobile });
    onEvent?.({ type: 'live-mode', kind: mode.kind, availability, mobile });
    if (mode.kind === 'speech') {
      setLiveNote('');
      liveAvailable = true;
      liveHandle = startLive({
        track,
        lang,
        onText: setLiveText,
        onError: () => { liveAvailable = false; setLiveText(''); setLiveNote(NOTES.unavailable); },
      });
    } else if (mode.kind === 'install') {
      setLiveNote(installing ? NOTES.installing : mode.note, { install: !installing });
    } else if (mode.kind === 'preview' && previewRetired) {
      setLiveNote(NOTES.retired);
    } else if (mode.kind === 'preview') {
      setLiveNote(NOTES.loading);
      let device;
      try { device = await loadPreview(); } catch {
        if (token === liveToken) setLiveNote(NOTES.unavailable);
        return;
      }
      if (destroyed || paused || !running || token !== liveToken) return;
      setLiveNote('');
      onEvent?.({ type: 'live-mode', kind: 'preview-ready', device });
      liveAvailable = true;
      previewLane = createPreviewLane({
        transcribe: previewTranscribe,
        onText: setLiveText,
        onRetire: () => {
          liveAvailable = false;
          previewRetired = true;
          previewLane = null;
          dropPreviewWorker();
          setLiveNote(NOTES.retired);
          onEvent?.({ type: 'live-mode', kind: 'retired' });
        },
      });
    } else {
      setLiveNote(mode.note);
    }
  }

  installBtn.addEventListener('click', () => {
    const lang = liveLangFor(settings.lang);
    if (!lang) return;
    // Called inside the tap, before any await: the download needs its user activation.
    const pending = installLive(lang);
    installing = true;
    setLiveNote(NOTES.installing);
    pending.then((ok) => {
      installing = false;
      if (destroyed) return;
      if (!ok) { setLiveNote(NOTES.installFailed); return; }
      setLiveNote('');
      if (running && !paused && captureHandle) setupLive(captureHandle.stream.getAudioTracks()[0]);
    });
  });

  function teardownLive() {
    liveToken++; // invalidates any setupLive() still awaiting liveAvailability
    liveHandle?.stop();
    liveHandle = null;
    previewLane?.stop();
    previewLane = null;
    liveAvailable = false;
    setLiveText('');
    if (!installing) setLiveNote('');
  }

  // --- Session wiring ---------------------------------------------------------
  let destroyed = false;
  const gate = createMeetingGate();
  let running = false;
  let stopping = false;
  let captureEpoch = 0;
  let paused = false;
  let wakeLock = null;
  let captureHandle = null;
  let session = null;
  let worker = null;
  let embed = null;
  let modelReady = null;
  let captureLost = false;
  let lateStatus = false;

  function setupWorker() {
    worker = new Worker(new URL('../embed-worker.js', import.meta.url), { type: 'module' });
    embed = createEmbedClient(worker, window.__ec?.embeds);
    modelReady = new Promise((resolve, reject) => {
      const onMsg = ({ data }) => {
        if (data.type === 'ready') { worker.removeEventListener('message', onMsg); resolve(); }
        else if (data.type === 'error' && data.id === undefined) {
          worker.removeEventListener('message', onMsg);
          reject(new Error(data.message));
        }
      };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', (event) => reject(new Error(`[huella] El modelo de voz se detuvo: ${event.message || 'error del worker'}.`)), { once: true });
    });
    worker.postMessage({ type: 'init', base: new URL('../vendor/', import.meta.url).href, slowdown: window.__ec?.cpuSlowdown });
  }
  setupWorker();

  function handleEvent(event) {
    if (destroyed) return;
    onEvent?.(event);
    if (event.type === 'bubble') {
      upsert(event.entry);
      liveHandle?.reset();
      previewLane?.bubble();
      persistTranscript();
    } else if (event.type === 'error') {
      setStatus(event.text, 'error');
    } else if (event.type === 'status' && !captureLost) {
      if (event.text) { setStatus(event.text); lateStatus = true; }
      else if (lateStatus) setRecordingStatus();
    }
  }

  // The only way «Grabando…» reaches the screen: it is shown after the capture
  // is checked, never assumed.
  function setRecordingStatus() {
    lateStatus = false;
    if (!checkCapture()) return;
    setStatus(running ? 'Grabando…' : '', 'ok');
  }

  function checkCapture() {
    if (!running || !captureHandle || captureLost) return !captureLost;
    const alive = captureHandle.alive();
    if (alive && !captureHandle.stalled()) return true;
    captureLost = true;
    teardownLive();
    setStatus(alive ? CAPTURE_STALLED : CAPTURE_LOST, 'error');
    onEvent?.({ type: 'capture-lost', stalled: alive });
    resumeBtn.hidden = false;
    talkBtn.disabled = true;
    pauseBtn.disabled = true;
    return false;
  }

  let stallTimer = null;
  function stopStallCheck() {
    clearInterval(stallTimer);
    stallTimer = null;
  }

  function onCaptureChange() {
    if (document.visibilityState === 'visible') checkCapture();
  }

  function warnNoWakeLock() {
    setStatus('La pantalla puede apagarse y cortar el micrófono. Mantén la app abierta.', 'error');
    wakeLockWarning = true;
  }

  async function requestWakeLock() {
    const epoch = captureEpoch;
    if (!('wakeLock' in navigator)) { if (!stopping && !destroyed) warnNoWakeLock(); return; }
    try {
      const lock = await navigator.wakeLock.request('screen');
      // «Terminar» and «Nueva reunión» both move the epoch: a lock granted after
      // either belongs to no meeting, and would keep the screen on after the next one.
      if (stopping || destroyed || epoch !== captureEpoch) { lock.release().catch(() => {}); return; }
      wakeLock = lock;
      if (wakeLockWarning) setRecordingStatus();
      wakeLock.addEventListener('release', () => { if (running) warnNoWakeLock(); });
    } catch {
      if (!stopping && !destroyed) warnNoWakeLock();
    }
  }

  // A phone that locked or backgrounded the page may have ended the microphone
  // or suspended the context; nothing reports it, so it is checked on return.
  function onVisibility() {
    if (document.visibilityState !== 'visible' || !running) return;
    captureHandle?.returned();
    if (checkCapture()) requestWakeLock();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onVisibility);

  // `audioContext` was created in the tap that started this; see capture.js.
  async function startRecording(audioContext) {
    const epoch = captureEpoch;
    let handle;
    let discarded = false;
    try {
      handle = await startCapture({
        onSegment: (seg) => {
          if (discarded) return;
          previewLane?.closed(seg.startedAt);
          session?.segment(seg);
        },
        onPreview: (seg) => previewLane?.offer(seg),
        // The worker runs one pass at a time: a lane rebuilt by pause/resume must not
        // post a second pass while the old lane's is still in the worker.
        canPreview: () => !!previewLane && previewLane.canPreview() && previewPending.size === 0,
        audioContext,
      });
    } catch (err) {
      if (destroyed || epoch !== captureEpoch) return;
      setStatus(err?.message || String(err), 'error');
      (captureLost ? resumeBtn : startBtn).hidden = false;
      return;
    }
    if (!mayInstallCapture({ destroyed, epoch, currentEpoch: captureEpoch })) {
      discarded = true;
      handle.stop().catch(() => {});
      return;
    }
    captureHandle = handle;
    captureHandle.pause(paused);
    for (const track of handle.stream.getAudioTracks()) track.addEventListener('ended', onCaptureChange);
    audioContext.addEventListener('statechange', onCaptureChange);
    captureLost = false;
    running = true;
    stopStallCheck();
    stallTimer = setInterval(checkCapture, STALL_CHECK_MS);
    resumeBtn.hidden = true;
    talkBtn.disabled = false;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
    setRecordingStatus();
    await requestWakeLock();
    if (!paused && epoch === captureEpoch) await setupLive(captureHandle.stream.getAudioTracks()[0]);
  }

  // Counts init()s still loading the print, the model or the microphone: a meeting
  // on its way to recording is already one the delete must wait for.
  let initPending = 0;
  async function init(audioContext) {
    initPending++;
    try { await initMeeting(audioContext); } finally { initPending--; }
  }

  async function initMeeting(audioContext) {
    forgotten = false;
    const print = await store.get('print');
    if (destroyed) { audioContext.close().catch(() => {}); return; }
    if (!print || print.model !== MODEL_ID) {
      audioContext.close().catch(() => {});
      setStatus('[huella] Falta tu huella de voz.', 'error');
      return;
    }
    setStatus('Cargando el modelo de voz…');
    preloadPreview();
    try {
      await modelReady;
    } catch (err) {
      audioContext.close().catch(() => {});
      if (!destroyed) setStatus(err?.message || String(err), 'error');
      return;
    }
    if (destroyed) { audioContext.close().catch(() => {}); return; }

    const speakers = createSpeakers(Float32Array.from(print.vector));
    session = createSession({
      embed,
      transcribe: (samples, signal) => transcribe(samples, settings, { signal }),
      speakers,
      onEvent: gate.bind(handleEvent),
      lang: () => settings.lang || 'en',
    });
    await startRecording(audioContext);
  }

  function showRestored(entries) {
    restored = entries;
    for (const entry of restored) {
      // Seeded so a translation stored with the transcript is shown, not redone.
      cache.set(entry.t, { text: entry.text, es: entry.es });
      upsert(entry, { interactive: false });
    }
  }

  startBtn.addEventListener('click', () => {
    report.reset();
    reportMd = null;
    const audioContext = createAudioContext();
    startBtn.hidden = true;
    if (session) startRecording(audioContext);
    else init(audioContext);
  });

  // Restarts capture into the same session: same transcript, same speakers.
  resumeBtn.addEventListener('click', () => {
    const audioContext = createAudioContext();
    resumeBtn.hidden = true;
    const old = captureHandle;
    captureHandle = null;
    if (old) old.stop().catch(() => {});
    setStatus('Reanudando…');
    startRecording(audioContext);
  });

  let chooser = null;
  function showResumeChooser(saved) {
    chooser = document.createElement('div');
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
      const audioContext = createAudioContext();
      chooser.remove();
      chooser = null;
      showRestored(saved);
      init(audioContext);
    });
    freshBtn.addEventListener('click', async () => {
      const audioContext = createAudioContext();
      chooser.remove();
      chooser = null;
      await store.del('lastTranscript').catch(() => {});
      init(audioContext);
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
    else {
      startBtn.hidden = false;
      if (finished && typeof saved.report === 'string' && saved.report) {
        reportMd = saved.report;
        report.show(saved.report);
      }
    }
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
    coach.reset();
    report.reset();
    reportMd = null;
    stopping = true;
    captureEpoch++;
    running = false;
    notifyMeetingChange();
    stopStallCheck();
    resumeBtn.hidden = true;
    talkBtn.disabled = true;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
    setStatus('Terminando…');
    teardownLive();
    if (wakeLock) { try { await wakeLock.release(); } catch { /* already gone */ } wakeLock = null; }
    const handle = captureHandle;
    captureHandle = null;
    if (handle) await handle.stop();
    // Pending embeds and transcription calls (including the segment stop() just flushed)
    // are still in flight: wait for every bubble they produce before the worker
    // that embeds them is freed and the screen calls itself finished — bounded,
    // so a stall elsewhere cannot leave "Terminar" on "Terminando…" forever.
    startBtn.hidden = true;
    resumeBtn.hidden = true;
    if (session) {
      await Promise.race([session.drain(), new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS))]);
      session.close();
    }
    gate.close();
    dropPreviewWorker();
    if (destroyed) return;
    worker.terminate();
    finishedAt = Date.now(); // a future mount must not offer this as unfinished
    persistTranscript();
    captureLost = false;
    setStatus('Reunión terminada.');
    reportBtn.hidden = false;
    newMeetingBtn.hidden = false;
    notifyMeetingChange();
  });

  newMeetingBtn.addEventListener('click', async () => {
    coach.reset();
    report.reset();
    reportMd = null;
    reportBtn.hidden = true;
    const audioContext = createAudioContext();
    newMeetingBtn.hidden = true;
    transcriptEl.textContent = '';
    cache.clear();
    restored = [];
    session = null;
    finishedAt = null;
    stopping = false;
    previewRetired = false;
    captureEpoch++;
    talkBtn.setAttribute('aria-pressed', 'false');
    talkBtn.classList.remove('on');
    pauseBtn.textContent = 'Pausar';
    paused = false;
    setStatus('');
    await store.del('lastTranscript').catch(() => {});
    setupWorker();
    await init(audioContext);
  });

  // Only between meetings: a running one re-persists after every bubble, and one
  // still draining after «Terminar» persists once more when it finishes.
  const changeListeners = new Set();
  const notifyMeetingChange = () => changeListeners.forEach((fn) => fn());
  const meetingLive = () => running || initPending > 0 || (stopping && !finishedAt);

  async function forget() {
    if (meetingLive()) return false;
    forgotten = true;
    coach.reset();
    report.reset();
    reportMd = null;
    reportBtn.hidden = true;
    transcriptEl.textContent = '';
    cache.clear();
    restored = [];
    session = null;
    if (chooser) { chooser.remove(); chooser = null; }
    if (newMeetingBtn.hidden) startBtn.hidden = false;
    setStatus('');
    await store.del('lastTranscript');
    return true;
  }

  function cleanup() {
    destroyed = true;
    running = false;
    stopStallCheck();
    coach.destroy();
    report.destroy();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onVisibility);
    session?.close();
    clearTimeout(toastTimer);
    teardownLive();
    if (wakeLock) wakeLock.release().catch(() => {});
    if (captureHandle) captureHandle.stop().catch(() => {});
    worker.terminate();
    dropPreviewWorker();
  }
  cleanup.live = meetingLive;
  cleanup.forget = forget;
  cleanup.onChange = (fn) => { changeListeners.add(fn); return () => changeListeners.delete(fn); };
  return cleanup;
}
