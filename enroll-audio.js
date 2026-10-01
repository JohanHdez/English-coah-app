// Pure helpers for turning the segments capture.js reports during enrollment into
// one take: a voiced-duration total to gate a too-quiet recording, and the raw
// samples concatenated for windows()/embed. Each segment already starts and ends
// at the Segmenter's own voicing threshold (lib/segmenter.js), so summing
// durationMs is summing time the segmenter itself judged voiced.

export function totalVoicedMs(segments) {
  return segments.reduce((sum, s) => sum + s.durationMs, 0);
}

export function concatSegments(segments) {
  const length = segments.reduce((n, s) => n + s.audio.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const s of segments) {
    out.set(s.audio, offset);
    offset += s.audio.length;
  }
  return out;
}
