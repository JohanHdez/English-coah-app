// The meeting screen: capture, segment, label, transcribe and translate a live
// conversation into «Yo / Interlocutor» bubbles. Recording starts the moment this
// screen mounts — there is no separate "ready" step once enrollment is done — and
// everything it owns (the worker, the microphone, the wake lock, on-device live
// recognition) is torn down by the returned cleanup function, since app.js can
// swap screens at any time (the header's settings button included).

import { createSession } from '../session.js';
import { createSpeakers } from '../speaker.js';
import { startCapture } from '../capture.js';
import { transcribeGroq } from '../transcribe.js';
import { toSpanish } from '../translate.js';
import { liveAvailability, startLive } from '../lib/live.js';
import { foldTranslation, nearBottom } from '../bubbles.js';
import { MODEL_ID } from '../embed.js';
import * as store from '../store.js';

const LIVE_LANG = 'en-US';

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
  controls.append(talkBtn, pauseBtn, stopBtn);
  section.append(controls);

  root.append(section);

  function setStatus(text, kind = 'info') {
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

  function bubbleNode(entry, cacheEntry) {
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

    div.addEventListener('click', () => correctBubble(entry));
    return div;
  }

  function upsert(entry) {
    const next = foldTranslation(cache.get(entry.t), entry.text);
    cache.set(entry.t, next);
    const node = bubbleNode(entry, next);
    const old = findBubble(entry.t);
    if (old) old.replaceWith(node); else insertByTime(node, entry.t);
    if (atBottom) stickToBottom();
  }

  // --- Live line ---------------------------------------------------------
  let liveHandle = null;
  let liveAvailable = false;

  function setLiveText(text) {
    liveTextEl.textContent = text;
    liveLineEl.hidden = !liveAvailable || !text;
  }

  async function setupLive(track) {
    const avail = await liveAvailability(LIVE_LANG);
    if (destroyed) return;
    liveAvailable = avail === 'available';
    if (!liveAvailable) return;
    liveHandle = startLive({
      track,
      lang: LIVE_LANG,
      onText: setLiveText,
      onError: () => { liveAvailable = false; setLiveText(''); },
    });
  }

  function teardownLive() {
    liveHandle?.stop();
    liveHandle = null;
    liveAvailable = false;
    setLiveText('');
  }

  // --- Session wiring ---------------------------------------------------------
  let destroyed = false;
  let running = false;
  let paused = false;
  let wakeLock = null;
  let captureHandle = null;
  let session = null;

  const worker = new Worker(new URL('../embed-worker.js', import.meta.url), { type: 'module' });
  const embed = createEmbedClient(worker);
  const modelReady = new Promise((resolve, reject) => {
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

  function handleEvent(event) {
    if (destroyed) return;
    onEvent?.(event);
    if (event.type === 'bubble') {
      upsert(event.entry);
      liveHandle?.reset();
      store.set('lastTranscript', session.transcript());
    } else if (event.type === 'error') {
      setStatus(event.text, 'error');
    }
  }

  function warnNoWakeLock() {
    setStatus('La pantalla puede apagarse y cortar el micrófono. Mantén la app abierta.', 'error');
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) { warnNoWakeLock(); return; }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
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
  init();

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
    if (!destroyed) setStatus('Reunión terminada.');
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
