// A stand-in for Groq's transcription endpoint, so the API engine can be driven
// without a key and without sending audio anywhere. It does not listen: it answers
// each request with the fixture sentence its audio most likely is, after a fixed
// delay, so a run measures how the queue and the two lanes behave — not accuracy.
//
// Which sentence: the segment's audio ended just before the request left (a
// closing pause of SILENCE_MS, or nothing at all after a forced cut), so its
// arrival time against the session's t0 places it on the fixture's timeline; the
// sentence it overlaps most is the answer. A running total of audio received was
// tried first and drifted, because a forced cut carries no closing silence.
//
// With `wav` (the fixture the microphone plays) the audio itself is located
// instead: arrival time includes however long the segment waited for its
// embeddings, which grows with the segment, so it misattributes once segments are
// split and forced-cut. The loudness envelope of the received audio is slid along
// the fixture's; the best normalised correlation is where it came from. Every cue
// the audio overlaps (0.3 s or more) is answered with the share of its words the
// overlap covers, in order, as a real recogniser would hear a segment that
// straddles a handoff. The arrival-time answer is still recorded
// next to it (`arrivalCue`) so the two can be compared.

import { createServer } from 'node:http';

// The closing pause a silence-cut segment carries after its last word.
const TAIL_S = 0.7;
const FRAME = 800; // 50 ms at 16 kHz
const MIN_FRAMES = 6;
const MIN_SCORE = 0.5;
const MIN_OVERLAP_S = 0.3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// The audio is a canonical 44-byte-header WAV (floatToWav) inside a multipart body.
function wavSeconds(body) {
  const riff = body.indexOf('RIFF');
  if (riff < 0) return 0;
  const rate = body.readUInt32LE(riff + 24);
  const bytes = body.readUInt32LE(riff + 40);
  return rate ? bytes / 2 / rate : 0;
}

// sqrt of the RMS per 50 ms frame, so a gain change (automatic gain control on the
// microphone path) barely moves it. Reads canonical 16-bit mono PCM from `from`.
function envelope(pcm, from) {
  const frames = Math.floor((pcm.length - from) / 2 / FRAME);
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = pcm.readInt16LE(from + (f * FRAME + i) * 2) / 32768;
      sum += v * v;
    }
    out[f] = Math.sqrt(Math.sqrt(sum / FRAME));
  }
  return out;
}

// Start (seconds) and score of the best placement of `part` along `whole`.
function locate(whole, part) {
  const n = part.length;
  if (n < MIN_FRAMES || whole.length < n) return null;
  let mean = 0;
  for (const v of part) mean += v;
  mean /= n;
  const z = Float64Array.from(part, (v) => v - mean);
  let norm = 0;
  for (const v of z) norm += v * v;
  if (norm < 1e-9) return null;
  let best = { score: -Infinity, frame: 0 };
  for (let k = 0; k + n <= whole.length; k++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += whole[k + i];
    m /= n;
    let dot = 0;
    let wn = 0;
    for (let i = 0; i < n; i++) {
      const d = whole[k + i] - m;
      dot += d * z[i];
      wn += d * d;
    }
    const score = wn > 1e-9 ? dot / Math.sqrt(wn * norm) : -1;
    if (score > best.score) best = { score, frame: k };
  }
  return { start: (best.frame * FRAME) / 16000, score: best.score };
}

function fieldOf(text, name) {
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(text);
  return m ? m[1] : null;
}

export async function startMockGroq({ manifest, delayMs = 900, wav = null }) {
  const requests = [];
  let t0 = Date.now();
  const whole = wav ? envelope(wav, 44) : null;

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (req.url === '/reset') { requests.length = 0; res.writeHead(200, CORS); res.end('ok'); return; }
    if (!/\/audio\/transcriptions$/.test(req.url || '')) { res.writeHead(404, CORS); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('latin1');
      const seconds = wavSeconds(body);
      const arrived = (Date.now() - t0) / 1000;
      const overlapOf = (cue, start, end) => Math.min(end, cue.end) - Math.max(start, cue.start);
      const bestAt = (start, end) => {
        let best = null;
        let bestOverlap = 0;
        for (const cue of manifest.cues) {
          const overlap = overlapOf(cue, start, end);
          if (overlap > bestOverlap) { bestOverlap = overlap; best = cue; }
        }
        return best;
      };
      const keyOf = (cue) => (cue ? cue.key ?? manifest.cues.indexOf(cue) : null);
      const arrivalCue = bestAt(arrived - TAIL_S - seconds, arrived - TAIL_S);
      const placed = whole ? locate(whole, envelope(body.subarray(body.indexOf('RIFF') + 44, body.indexOf('RIFF') + 44 + Math.round(seconds * 32000)), 0)) : null;
      const slices = [];
      let start = arrived - TAIL_S - seconds;
      let end = arrived - TAIL_S;
      if (placed && placed.score >= MIN_SCORE) {
        start = placed.start;
        end = start + seconds;
        // A real recogniser transcribes whatever words fall in the audio: a cue the
        // segment only partly overlaps contributes the matching share of its words.
        for (const cue of manifest.cues) {
          const overlap = overlapOf(cue, start, end);
          if (overlap < MIN_OVERLAP_S) continue;
          const toks = cue.text.split(/\s+/);
          const dur = cue.end - cue.start;
          const share = overlap / dur;
          const k = share >= 0.97 ? toks.length : Math.max(1, Math.round(share * toks.length));
          const from = Math.min(toks.length - k, Math.round((Math.max(0, start - cue.start) / dur) * toks.length));
          slices.push({ cue: manifest.cues.indexOf(cue), from: share >= 0.97 ? 0 : from, to: (share >= 0.97 ? 0 : from) + k });
        }
      } else {
        if (arrivalCue) slices.push({ cue: manifest.cues.indexOf(arrivalCue), from: 0, to: arrivalCue.text.split(/\s+/).length });
      }
      const language = fieldOf(text, 'language');
      const format = fieldOf(text, 'response_format');
      const entry = {
        n: requests.length + 1, at: Date.now(), seconds: Math.round(seconds * 10) / 10, language, format,
        cue: slices.length ? keyOf(manifest.cues[slices[0].cue]) : null,
        slices,
        arrivalCue: keyOf(arrivalCue),
        start: Math.round(start * 100) / 100,
        score: placed ? Math.round(placed.score * 100) / 100 : null,
      };
      requests.push(entry);
      await sleep(delayMs);
      const out = { text: slices.length ? slices.map((x) => manifest.cues[x.cue].text.split(/\s+/).slice(x.from, x.to).join(' ')).join(' ') : `[mock turn ${entry.n}]` };
      if (format === 'verbose_json' && slices.length) out.language = manifest.cues[slices[0].cue].lang === 'es' ? 'spanish' : 'english';
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reset: () => { requests.length = 0; },
    // The page's clock and this process's are the same wall clock.
    setT0: (ms) => { t0 = ms; },
    close: () => new Promise((r) => server.close(r)),
  };
}
