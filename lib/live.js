// Provisional live transcription using the on-device Web Speech API (Chrome 139+).
//
// Whisper remains the authoritative source: this only shows text ahead of it while
// the person is speaking, and it is discarded as soon as the real segment lands.
// Everything produced here is provisional and never stored in the transcript.
//
// Two details that shape the design:
//   - start() accepts a MediaStreamTrack, so the tab's track can be handed to it.
//     Without that it would only hear the microphone, which is useless here.
//   - processLocally requires an installed language pack. If it is missing we say
//     so and stay idle: it NEVER falls back to cloud recognition, because that
//     would ship the other speaker's audio off the machine without telling anyone.

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture']);

export const liveSupported = () => !!SR;

export async function liveAvailability(lang = 'en-US') {
  if (!SR) return 'unsupported';
  if (typeof SR.available !== 'function') return 'unknown';
  try {
    const r = await SR.available({ langs: [lang], processLocally: true });
    if (typeof r === 'string') return r;
    return r ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function installLive(lang = 'en-US') {
  if (!SR || typeof SR.install !== 'function') return false;
  try {
    return (await SR.install({ langs: [lang], processLocally: true })) !== false;
  } catch {
    return false;
  }
}

export function startLive({ track, lang = 'en-US', onText, onError } = {}) {
  if (!SR || !track) return null;

  let rec = null;
  let wanted = true;
  // Results before `base` are in a bubble already. So is the head of what follows,
  // up to `dropped` characters: a speaker who never pauses holds one growing
  // interim result for the whole monologue, and Whisper's forced cut lands a turn
  // every eight seconds of it. Skipping that result whole would blank the line
  // until they finally paused — the words they are still saying live in its tail.
  let base = 0;
  let dropped = 0;
  let last = [];

  const emit = (results) => {
    last = results;
    let text = '';
    for (let i = base; i < results.length; i++) text += results[i][0]?.transcript || '';
    // The final that replaces an interim may respell it, so a count of characters
    // can land mid-word: move the cut to the next space.
    let cut = Math.min(dropped, text.length);
    if (cut > 0 && cut < text.length && text[cut] !== ' ' && text[cut - 1] !== ' ') {
      const space = text.indexOf(' ', cut);
      cut = space < 0 ? text.length : space;
    }
    onText?.(text.slice(cut).trim());
  };

  const build = () => {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.processLocally = true;

    r.onresult = (e) => emit(e.results);
    r.onerror = (e) => {
      const code = e.error || 'unknown';
      if (FATAL.has(code)) {
        wanted = false;
        onError?.(code);
      }
    };
    r.onend = () => {
      if (!wanted) return;
      base = 0;
      dropped = 0;
      last = [];
      setTimeout(() => { if (wanted) launch(); }, 300);
    };
    return r;
  };

  const launch = () => {
    try {
      rec = build();
      rec.start(track);
    } catch (e) {
      wanted = false;
      onError?.(e?.message || String(e));
    }
  };

  launch();

  return {
    // Called once Whisper delivered the real segment: what the line showed is in
    // the bubble now. Finalised results are skipped outright; an interim still
    // growing is skipped only as far as it had got.
    reset() {
      base = 0;
      while (base < last.length && last[base].isFinal) base++;
      dropped = 0;
      for (let i = base; i < last.length; i++) dropped += (last[i][0]?.transcript || '').length;
      onText?.('');
    },
    stop() {
      wanted = false;
      try { rec?.stop(); } catch { /* ya estaba parado */ }
      rec = null;
    },
  };
}
