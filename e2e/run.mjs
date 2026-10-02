// The whole app, scored: a synthetic meeting plays through Chrome's fake microphone
// into the real meeting screen, Groq is a localhost stand-in, and every cue's
// «Yo» / «Interlocutor» label and bubble latency is compared with the fixture's
// ground truth. Needs the fixtures (node e2e/fixtures.mjs). Nothing here reaches a
// real external API; the voice model's first download from Hugging Face is the one
// exception, and it is the app's own dependency.
//
// Usage: node e2e/run.mjs <learner> <other> [--condition=room|clean] [--delay=900] [--lang=en|multi] [--throttle=4]
//
// --throttle=N stands in for a phone's CPU; it is not a phone measurement. The page
// is slowed N× with Emulation.setCPUThrottlingRate, which DevTools refuses for
// workers, so the embed worker holds its thread for (N − 1)× each inference's time.
// The audio worklet is not slowed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runConversation, slug, FIXTURES } from './harness.mjs';
import { score } from './score.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
if (positional.length < 2) {
  console.error('usage: node e2e/run.mjs <learner> <other> [--condition=room|clean] [--delay=900] [--lang=en|multi] [--throttle=4]');
  process.exit(2);
}
const [learner, other] = positional;
const condition = opt('condition', 'room');
const delayMs = Number(opt('delay', '900'));
const lang = opt('lang', 'en');
const cpuThrottle = Number(opt('throttle', '0'));

const pad = (s, n) => String(s).padEnd(n);
const fmt = (v, d = 1) => (v === null || v === undefined ? '-' : v.toFixed(d));
const pct = (v) => (v === null ? '-' : `${(v * 100).toFixed(1)} %`);

const run = await runConversation({ learner, other, condition, delayMs, lang, cpuThrottle });
const { perCue, totals } = score(run);
const cost = embedCost(run);

// Embedding cost per second of speech: the time each segment spent in labelling
// (window scan + label embeds, serial in the worker) over the segment's own
// length. The worker's own round trips are summed separately.
function embedCost({ events, embeds }) {
  const labelled = events.filter((e) => e.type === 'labelled');
  const speechS = labelled.reduce((a, e) => a + e.durationMs, 0) / 1000;
  const labelMs = labelled.reduce((a, e) => a + e.embedMs, 0);
  const ms = embeds.map((e) => e.ms).sort((a, b) => a - b);
  const q = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : null);
  return {
    segments: labelled.length,
    speechS,
    msPerSpeechS: speechS ? labelMs / speechS : null,
    workerMs: ms.reduce((a, b) => a + b, 0),
    embeds: ms.length,
    embedP50: q(0.5),
    embedP90: q(0.9),
    skipped: labelled.filter((e) => !e.scanned && e.durationMs >= 3000).length,
    long: labelled.filter((e) => e.durationMs >= 3000).length,
    maxBacklogS: labelled.reduce((a, e) => Math.max(a, e.backlogMs), 0) / 1000,
  };
}

console.log(`\n${learner} (learner) with ${other} · ${condition} · stand-in delay ${delayMs} ms${cpuThrottle ? ` · CPU throttled ${cpuThrottle}×` : ''} · fixtures in ${FIXTURES}`);
console.log(`\n${pad('cue', 4)}${pad('truth', 7)}${pad('bubble', 8)}${pad('ok', 5)}${pad('lat s', 8)}${pad('words', 8)}text`);
for (const c of perCue) {
  const label = c.bubble ?? 'none';
  const ok = c.bubble === null ? 'miss' : c.bubble === c.truth ? 'yes' : 'NO';
  console.log(`${pad(c.idx + 1, 4)}${pad(c.truth, 7)}${pad(label, 8)}${pad(ok, 5)}${pad(fmt(c.latencyS), 8)}${pad(`${c.matched}/${c.words}`, 8)}${c.text.slice(0, 48)}`);
}

console.log('\ntotals');
console.log(`  speaker accuracy (words)  ${pct(totals.accuracy)} of ${totals.words} words`);
console.log(`  cues heard                ${totals.cuesHeard}/${totals.cues}`);
console.log(`  bubbles                   ${totals.bubbles} (${totals.mixedBubbles} mixed)`);
console.log(`  audio-mixed requests      ${totals.audioMixedRequests}/${totals.requests} (segments whose audio holds both speakers)`);
console.log(`  latency after cue end     p50 ${fmt(totals.latencyP50)} s · p90 ${fmt(totals.latencyP90)} s`);
console.log(`  stand-in requests         ${totals.requests} (${totals.skippedRequests} never reached a bubble, ${totals.unmatchedWords} bubble words unmatched)`);
console.log(`  stand-in matching         audio alignment placed ${totals.alignedRequests}/${totals.requests}; arrival time alone would have picked another cue for ${totals.arrivalDisagrees}`);
console.log(`  embedding                 ${fmt(cost.msPerSpeechS, 0)} ms per s of speech (${cost.segments} segments, ${fmt(cost.speechS)} s); ${cost.embeds} embeds p50 ${fmt(cost.embedP50, 0)} ms · p90 ${fmt(cost.embedP90, 0)} ms`);
console.log(`  window scan               skipped for ${cost.skipped}/${cost.long} segments of 3 s or more (largest backlog ${fmt(cost.maxBacklogS)} s)`);
console.log(`  error events              ${totals.errorEvents}`);
console.log(`  console errors            ${run.errors.length}`);
for (const e of run.errors.slice(0, 5)) console.log(`    ${e}`);

if (run.errors.length || totals.errorEvents) process.exitCode = 1;

const dir = join(FIXTURES, '..', 'results');
mkdirSync(dir, { recursive: true });
const file = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(learner)}-${slug(other)}-${condition}${cpuThrottle ? `-cpu${cpuThrottle}x` : ''}.json`);
writeFileSync(file, JSON.stringify({ args: { learner, other, condition, delayMs, lang, cpuThrottle }, totals, cost, perCue, run }, null, 1));
console.log(`\nsaved ${file}`);
