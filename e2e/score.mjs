// Scores one whole-app run against the fixture's manifest. Pure: it reads the
// events the page recorded and the Groq stand-in's request log, nothing else.
//
// The stand-in answers each segment with the manifest cues its audio covers, so a
// bubble's words can be traced back to cues by replaying the answers in capture
// order against the words the bubbles ended up with; a request whose words never
// reach a bubble (dropped as junk, or failed) is skipped and counted. Latency is
// when a cue's last word first became visible in any bubble, after the cue ended.

export const words = (text) => String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

export function score({ manifest, micT0, events, requests }) {
  const cues = manifest.cues;

  const last = new Map();
  for (const e of events) if (e.type === 'bubble') last.set(e.entry.t, e.entry);
  const bubbles = [...last.values()].sort((a, b) => a.t - b.t);

  const stream = [];
  const sorted = [...requests].sort((a, b) => a.start - b.start || a.n - b.n);
  sorted.forEach((req, r) => {
    const list = req.cues.length ? req.cues : [-1];
    for (const c of list) {
      const toks = c >= 0 ? words(cues[c].text) : words(`mock turn ${req.n}`);
      toks.forEach((w, i) => stream.push({ w, cue: c, req: r, first: i === 0 && c === list[0] }));
    }
  });

  // Replays the stream against the bubbles' words; a mismatch jumps to the next
  // request that opens with the word at hand and counts the ones passed over.
  const tagged = [];
  let p = 0;
  const skipped = new Set();
  for (const bubble of bubbles) {
    const tags = [];
    for (const w of words(bubble.text)) {
      if (stream[p]?.w === w) { tags.push(stream[p].cue); p++; continue; }
      let q = p;
      while (q < stream.length && !(stream[q].first && stream[q].w === w)) q++;
      if (q < stream.length) {
        for (let k = p; k < q; k++) skipped.add(stream[k].req);
        tags.push(stream[q].cue);
        p = q + 1;
      } else {
        tags.push(-1);
      }
    }
    tagged.push({ bubble, tags });
  }

  for (let k = p; k < stream.length; k++) skipped.add(stream[k].req);

  const reached = [];
  const count = new Map();
  let total = 0;
  let peak = 0;
  for (const e of events) {
    if (e.type !== 'bubble') continue;
    total += words(e.entry.text).length - (count.get(e.entry.t) || 0);
    count.set(e.entry.t, words(e.entry.text).length);
    while (peak < total) reached[++peak] = e.t;
  }

  const perCue = cues.map((cue, idx) => ({
    idx, truth: cue.speaker, lang: cue.lang, text: cue.text, end: cue.end,
    words: words(cue.text).length, matched: 0, me: 0, them: 0, lastRank: 0,
  }));
  let rank = 0;
  for (const { bubble, tags } of tagged) {
    for (const c of tags) {
      rank++;
      if (c < 0) continue;
      perCue[c].matched++;
      perCue[c][bubble.speaker === 'me' ? 'me' : 'them']++;
      perCue[c].lastRank = rank;
    }
  }
  for (const c of perCue) {
    c.bubble = c.matched === 0 ? null : c.me >= c.them ? 'me' : 'them';
    c.coverage = c.words ? Math.min(1, c.matched / c.words) : 0;
    c.latencyS = c.matched && reached[c.lastRank] ? (reached[c.lastRank] - (micT0 + c.end * 1000)) / 1000 : null;
  }

  const truthOf = (c) => cues[c].speaker;
  let mixed = 0;
  for (const { tags } of tagged) {
    const set = new Set(tags.filter((c) => c >= 0).map(truthOf));
    if (set.size > 1) mixed++;
  }

  const matchedWords = perCue.reduce((n, c) => n + c.me + c.them, 0);
  const correctWords = perCue.reduce((n, c) => n + (c.truth === 'me' ? c.me : c.them), 0);
  const latencies = perCue.map((c) => c.latencyS).filter((v) => v !== null).sort((a, b) => a - b);
  const placed = requests.filter((r) => r.score !== null);

  return {
    perCue,
    totals: {
      cues: cues.length,
      cuesHeard: perCue.filter((c) => c.matched).length,
      bubbles: bubbles.length,
      mixedBubbles: mixed,
      words: matchedWords,
      accuracy: matchedWords ? correctWords / matchedWords : null,
      latencyP50: quantile(latencies, 0.5),
      latencyP90: quantile(latencies, 0.9),
      requests: requests.length,
      skippedRequests: skipped.size,
      unmatchedWords: tagged.reduce((n, t) => n + t.tags.filter((c) => c < 0).length, 0),
      alignedRequests: placed.length,
      arrivalDisagrees: placed.filter((r) => r.arrivalCue !== r.cue).length,
      errorEvents: events.filter((e) => e.type === 'error').length,
    },
  };
}
