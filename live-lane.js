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
  retired: 'La transcripción en vivo se apagó: este dispositivo no la procesa a tiempo.',
};

// `lang` is the recogniser's language, null for a bilingual meeting. The preview
// model is an English-only export, so it covers English meetings alone.
export function liveMode({ lang, availability, webgpu, preview }) {
  if (!lang) return { kind: 'off', note: NOTES.bilingual };
  if (availability === 'available') return { kind: 'speech', note: null };
  if (availability === 'downloadable' || availability === 'downloading') return { kind: 'install', note: NOTES.install };
  if (webgpu && lang.startsWith('en')) return preview ? { kind: 'preview', note: null } : { kind: 'off', note: NOTES.disabled };
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
      Promise.resolve(transcribe(audio)).then((text) => {
        if (stopped || retired) return;
        if (now() - t0 > PREVIEW_MAX_MS) {
          if (++slow >= PREVIEW_SLOW_ROUNDS) {
            retired = true;
            paint('');
            onRetire?.();
            return;
          }
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
      }, () => {}).finally(() => { busy = false; });
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
