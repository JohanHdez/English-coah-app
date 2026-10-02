// The whole app, scored: a synthetic meeting plays through Chrome's fake microphone
// into the real meeting screen, Groq is a localhost stand-in, and every cue's
// «Yo» / «Interlocutor» label and bubble latency is compared with the fixture's
// ground truth. Needs the fixtures (node e2e/fixtures.mjs). Nothing here reaches a
// real external API; the voice model's first download from Hugging Face is the one
// exception, and it is the app's own dependency.
//
// Usage: node e2e/run.mjs <learner> <other> [--condition=room|clean] [--delay=900] [--lang=en|multi]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runConversation, slug, FIXTURES } from './harness.mjs';
import { score } from './score.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
if (positional.length < 2) {
  console.error('usage: node e2e/run.mjs <learner> <other> [--condition=room|clean] [--delay=900] [--lang=en|multi]');
  process.exit(2);
}
const [learner, other] = positional;
const condition = opt('condition', 'room');
const delayMs = Number(opt('delay', '900'));
const lang = opt('lang', 'en');

const pad = (s, n) => String(s).padEnd(n);
const fmt = (v, d = 1) => (v === null || v === undefined ? '-' : v.toFixed(d));
const pct = (v) => (v === null ? '-' : `${(v * 100).toFixed(1)} %`);

const run = await runConversation({ learner, other, condition, delayMs, lang });
const { perCue, totals } = score(run);

console.log(`\n${learner} (learner) with ${other} · ${condition} · stand-in delay ${delayMs} ms · fixtures in ${FIXTURES}`);
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
console.log(`  error events              ${totals.errorEvents}`);
console.log(`  console errors            ${run.errors.length}`);
for (const e of run.errors.slice(0, 5)) console.log(`    ${e}`);

if (run.errors.length || totals.errorEvents) process.exitCode = 1;

const dir = join(FIXTURES, '..', 'results');
mkdirSync(dir, { recursive: true });
const file = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(learner)}-${slug(other)}-${condition}.json`);
writeFileSync(file, JSON.stringify({ args: { learner, other, condition, delayMs, lang }, totals, perCue, run }, null, 1));
console.log(`\nsaved ${file}`);
