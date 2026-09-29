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

import { createServer } from 'node:http';

// The closing pause a silence-cut segment carries after its last word.
const TAIL_S = 0.7;
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

function fieldOf(text, name) {
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(text);
  return m ? m[1] : null;
}

export async function startMockGroq({ manifest, delayMs = 900 }) {
  const requests = [];
  let t0 = Date.now();

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
      const end = arrived - TAIL_S;
      const start = end - seconds;
      let best = null;
      let bestOverlap = 0;
      for (const cue of manifest.cues) {
        const overlap = Math.min(end, cue.end) - Math.max(start, cue.start);
        if (overlap > bestOverlap) { bestOverlap = overlap; best = cue; }
      }
      const language = fieldOf(text, 'language');
      const format = fieldOf(text, 'response_format');
      const entry = { n: requests.length + 1, at: Date.now(), seconds: Math.round(seconds * 10) / 10, language, format, cue: best ? best.key : null };
      requests.push(entry);
      await sleep(delayMs);
      const out = { text: best ? best.text : `[mock turn ${entry.n}]` };
      if (format === 'verbose_json' && best) out.language = best.lang === 'es' ? 'spanish' : 'english';
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
