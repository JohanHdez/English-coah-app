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

export async function startCapture({ onSegment, onLevel, onBlock, constraints } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...DEFAULT_CONSTRAINTS, ...constraints } });
  } catch (err) {
    throw micError(err);
  }

  // Everything past this point can fail independently of the permission
  // prompt (a bad AudioContext, addModule rejecting, …); none of those
  // failures should leave the microphone recording with nobody listening.
  let audioContext;
  try {
    audioContext = new AudioContext({ sampleRate: 16000 });
    // Safari creates a context already suspended; nothing downstream would
    // ever be pulled without this.
    await audioContext.resume();
    await audioContext.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));

    const source = audioContext.createMediaStreamSource(stream);
    // Some browsers ignore the requested sampleRate, and Firefox refuses to
    // connect a MediaStreamSource to a context whose rate differs from the
    // device's: the worklet resamples to 16 kHz itself whenever the two
    // disagree (see recorder-worklet.js).
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
      stop() {
        // Whatever the learner was saying when Stop was pressed must still
        // reach the transcript: flush() emits the open phrase instead of
        // discarding it mid-utterance (ported from the extension, which
        // calls the same flush on stop and on pause — offscreen.js:702, 736).
        segmenter.flush();
        worklet.port.onmessage = null;
        worklet.disconnect();
        source.disconnect();
        mute.disconnect();
        for (const track of stream.getTracks()) track.stop();
        return audioContext.close();
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
    if (audioContext) await audioContext.close().catch(() => {});
    throw micError(err);
  }
}
