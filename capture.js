// Microphone capture: an AudioWorklet at the device's own rate, resampling to
// 16 kHz, feeding the shared Segmenter. Browser
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

const RESUME_TIMEOUT_MS = 3000;

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

// Chrome and Safari only let an AudioContext run if it is created and resumed
// during a user gesture; the gesture's activation does not outlive the
// getUserMedia prompt reliably, so the caller makes this context synchronously
// inside its click handler, before any await. No sampleRate: Firefox refuses to
// connect a microphone to a context whose rate differs from the device's, and the
// worklet resamples to 16 kHz itself.
export function createAudioContext() {
  const context = new AudioContext();
  context.resume().catch(() => {});
  return context;
}

export async function startCapture({ onSegment, onLevel, onBlock, constraints, audioContext: given } = {}) {
  const audioContext = given || createAudioContext();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...DEFAULT_CONSTRAINTS, ...constraints } });
  } catch (err) {
    await audioContext.close().catch(() => {});
    throw micError(err);
  }

  // Everything past this point can fail independently of the permission
  // prompt (a bad AudioContext, addModule rejecting, …); none of those
  // failures should leave the microphone recording with nobody listening.
  try {
    // Without a gesture resume() never settles; bounded, so the screen can say
    // so and offer the tap again instead of waiting forever.
    await Promise.race([audioContext.resume(), new Promise((r) => setTimeout(r, RESUME_TIMEOUT_MS))]);
    if (audioContext.state !== 'running') throw new Error('El navegador no dejó arrancar el audio; toca el botón otra vez.');
    await audioContext.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));

    const source = audioContext.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(audioContext, 'recorder-processor', {
      processorOptions: { inputRate: audioContext.sampleRate },
    });
    // A worklet with nothing downstream is not guaranteed to be pulled, so its
    // output is muted rather than left disconnected.
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(audioContext.destination);

    // onSegment is optional: enrollment only wants onBlock's raw, ungrouped
    // blocks, and a live Segmenter with no listener would throw the moment a
    // phrase actually closed.
    const segmenter = new Segmenter('mixed', onSegment || (() => {}));
    let paused = false;
    worklet.port.onmessage = ({ data }) => {
      if (onLevel) onLevel(data.rms);
      if (onBlock) onBlock(data);
      if (paused) return;
      segmenter.push(data);
    };

    return {
      stream,
      // A backgrounded or locked phone may end the microphone track or leave the
      // context 'suspended' / 'interrupted' (iOS) with no error anywhere; the
      // screen asks this whenever it comes back into view.
      alive() {
        return audioContext.state === 'running'
          && stream.getAudioTracks().every((track) => track.readyState === 'live');
      },
      stop() {
        // Whatever the learner was saying when Stop was pressed must still
        // reach the transcript: flush() emits the open phrase instead of
        // discarding it mid-utterance (ported from the extension, which
        // calls the same flush on stop and on pause — offscreen.js:702, 736).
        segmenter.flush();
        worklet.port.onmessage = null;
        worklet.port.close();
        worklet.disconnect();
        source.disconnect();
        mute.disconnect();
        for (const track of stream.getTracks()) track.stop();
        return audioContext.state === 'closed' ? Promise.resolve() : audioContext.close();
      },
      pause(next) {
        // Flushing on pause, not only on stop, keeps the phrase open at that
        // moment from being joined, after resume, to audio spoken during the
        // gap — without this it would keep the old startedAt and read as one
        // run-on segment spanning the pause.
        if (next && !paused) segmenter.flush();
        paused = next;
      },
    };
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    await audioContext.close().catch(() => {});
    throw micError(err);
  }
}
