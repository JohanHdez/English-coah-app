// Which live line a meeting gets, and the local Whisper preview lane that stands in
// for on-device recognition where the browser has none. Pure: the recogniser's
// availability, WebGPU and the transcription call are all handed in.

import { EMPTY, stitch } from './lib/stitch.js';
import { isJunk } from './lib/segmenter.js';

// The extension's slowness rule: a pass has to cost less than the interval that
// schedules it, or the lane stops paying for itself. Two slow rounds in a row and
// it retires for the rest of the meeting.
export const PREVIEW_MAX_MS = 1500;
export const PREVIEW_SLOW_ROUNDS = 2;

export const NOTES = {
  install: 'La transcripción en vivo necesita el reconocimiento de voz del navegador (se descarga una vez).',
  installing: 'Instalando el reconocimiento de voz…',
  loading: 'Cargando la transcripción en vivo de este dispositivo (unos 120 MB la primera vez)…',
  installFailed: '[en vivo] No se pudo instalar el reconocimiento de voz; las burbujas llegan al terminar cada frase.',
  unavailable: 'La transcripción en vivo no está disponible en este dispositivo o navegador; las burbujas llegan al terminar cada frase.',
  bilingual: 'Sin transcripción en vivo en una reunión bilingüe: el reconocimiento de voz solo oye un idioma.',
  disabled: 'La transcripción en vivo con el modelo local está apagada en Ajustes.',
  optIn: 'Sin texto en vivo: puedes activar Whisper local en Ajustes (descarga ~120 MB la primera vez).',
  retired: 'La transcripción en vivo se apagó: este dispositivo no la procesa a tiempo.',
};

// The preview model is about 120 MB on first use: a phone or tablet, likely on
// mobile data, downloads it only once the learner turns it on in Ajustes.
export function isMobile({ uaDataMobile, userAgent = '', maxTouchPoints = 0, coarse = false, shortSide = Infinity } = {}) {
  // Client hints answer `mobile: false` on an Android tablet, which is still a
  // tablet on mobile data as far as a 120 MB download goes.
  if (uaDataMobile === true || /Android|iPhone|iPad|iPod/i.test(userAgent)) return true;
  if (uaDataMobile === false) return false;
  if (/Mobile/i.test(userAgent)) return true;
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return true; // iPadOS reports a Mac
  return coarse && shortSide < 768;
}

// The facts isMobile() reads, from an injected environment (the page passes
// globalThis), so the decision itself stays testable.
export function deviceFacts(env = globalThis) {
  const nav = env.navigator || {};
  const screen = env.screen;
  return {
    uaDataMobile: nav.userAgentData?.mobile,
    userAgent: nav.userAgent || '',
    maxTouchPoints: nav.maxTouchPoints || 0,
    coarse: !!env.matchMedia?.('(pointer: coarse)').matches,
    shortSide: screen ? Math.min(screen.width, screen.height) : Infinity,
  };
}

// `livePreview` is tri-state: true/false is the learner's choice in Ajustes,
// unset follows the device — on for a desktop, off for a phone or tablet.
export const previewEnabled = (setting, mobile) => (typeof setting === 'boolean' ? setting : !mobile);

// `lang` is the recogniser's language, null for a bilingual meeting. The preview
// model is an English-only export, so it covers English meetings alone.
export function liveMode({ lang, availability, webgpu, preview, mobile = false }) {
  if (!lang) return { kind: 'off', note: NOTES.bilingual };
  if (availability === 'available') return { kind: 'speech', note: null };
  if (availability === 'downloadable' || availability === 'downloading') return { kind: 'install', note: NOTES.install };
  if (webgpu && lang.startsWith('en')) {
    if (previewEnabled(preview, mobile)) return { kind: 'preview', note: null };
    return { kind: 'off', note: preview === false ? NOTES.disabled : NOTES.optIn };
  }
  return { kind: 'off', note: NOTES.unavailable };
}

// Provisional text only: what it paints is never stored and never leaves the device.
// `closed(startedAt)` is told when the segmenter emits a piece, `bubble()` when a
// bubble lands. A line belonging to a piece still being spoken survives a bubble —
// blanking the words under someone who is still talking is the bug this exists for.
export function createPreviewLane({ transcribe, onText, now = () => Date.now(), onRetire }) {
  let busy = false;
  let stopped = false;
  let retired = false;
  let slow = 0;
  let state = EMPTY;
  let piece = null;
  let shownPiece = null;
  let closedUpTo = -Infinity;

  const paint = (text) => { if (!stopped) onText?.(text); };

  return {
    canPreview: () => !busy && !stopped && !retired,

    offer({ audio, startedAt }) {
      if (busy || stopped || retired) return;
      busy = true;
      const t0 = now();
      // A failed pass counts like a slow one: a worker that errors on every pass
      // (a lost GPU device) would otherwise be fed audio forever behind a blank line.
      const bad = () => {
        if (++slow < PREVIEW_SLOW_ROUNDS) return false;
        retired = true;
        paint('');
        onRetire?.();
        return true;
      };
      Promise.resolve(transcribe(audio)).then((text) => {
        if (stopped || retired) return;
        if (now() - t0 > PREVIEW_MAX_MS) {
          if (bad()) return;
        } else {
          slow = 0;
        }
        const clean = String(text || '').trim();
        if (isJunk(clean) || startedAt <= closedUpTo) return;
        if (piece !== startedAt) { state = EMPTY; piece = startedAt; }
        const out = stitch(state, clean);
        state = out.state;
        shownPiece = startedAt;
        paint(`${out.committed} ${out.tail}`.trim());
      }, () => { if (!stopped && !retired) bad(); }).finally(() => { busy = false; });
    },

    closed(startedAt) {
      closedUpTo = Math.max(closedUpTo, startedAt);
    },

    bubble() {
      if (shownPiece === null || shownPiece > closedUpTo) return;
      shownPiece = null;
      state = EMPTY;
      piece = null;
      paint('');
    },

    stop() {
      if (!stopped) onText?.('');
      stopped = true;
    },
  };
}
