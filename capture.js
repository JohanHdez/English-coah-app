// Microphone capture: a 16 kHz AudioWorklet feeding the shared Segmenter. Browser
// DOM/media APIs only — no `chrome.*`-equivalent here, but also nothing pure
// about it, so it is not covered by node --test (see session.test.js instead for
// everything downstream of a segment).

import { Segmenter } from './lib/segmenter.js';

const DEFAULT_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
  channelCount: 1,
};

function micError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return new Error('[micrófono] Permiso de micrófono denegado.');
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new Error('[micrófono] No hay micrófono disponible.');
  }
  return new Error(`[micrófono] ${err?.message || err}`);
}

export async function startCapture({ onSegment, onLevel, constraints } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...DEFAULT_CONSTRAINTS, ...constraints } });
  } catch (err) {
    throw micError(err);
  }

  const audioContext = new AudioContext({ sampleRate: 16000 });
  await audioContext.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, 'recorder-processor');
  // A worklet with nothing downstream is not guaranteed to be pulled, so its
  // output is muted rather than left disconnected.
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  source.connect(worklet);
  worklet.connect(mute);
  mute.connect(audioContext.destination);

  const segmenter = new Segmenter('mixed', onSegment);
  let paused = false;
  worklet.port.onmessage = ({ data }) => {
    if (onLevel) onLevel(data.rms);
    if (paused) return;
    segmenter.push(data);
  };

  return {
    stream,
    stop() {
      worklet.port.onmessage = null;
      worklet.disconnect();
      source.disconnect();
      mute.disconnect();
      for (const track of stream.getTracks()) track.stop();
      return audioContext.close();
    },
    pause(next) {
      paused = next;
    },
  };
}
