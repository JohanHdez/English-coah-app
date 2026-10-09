// The whole app, scored: a synthetic meeting plays through Chrome's fake microphone
// into the real meeting screen, Groq is a localhost stand-in, and every cue's
// «Yo» / «Interlocutor» label and bubble latency is compared with the fixture's
// ground truth. Needs the fixtures (node e2e/fixtures.mjs). Nothing here reaches a
// real external API; the voice model's first download from Hugging Face is the one
// exception, and it is the app's own dependency.
//
// Usage: node e2e/run.mjs <learner> <other> [--condition=room|clean] [--delay=900] [--lang=en|multi] [--throttle=4]
//                         [--transcribe=groq|openai|gemini] [--chat=groq|openai|gemini|anthropic]
//                         [--live=speech|preview|none] [--preview-model=onnx-community/whisper-base.en]
//
// --transcribe picks the provider whose request shape carries the audio (default
// groq); every one is answered by the same stand-in. --chat turns translation on
// through that provider's shape, with the browser's own Translator hidden; without
// it translation stays off, as in the Phase 1 runs.
//
// --throttle=N stands in for a phone's CPU; it is not a phone measurement. The page
// is slowed N× with Emulation.setCPUThrottlingRate, which DevTools refuses for
// workers, so the embed worker holds its thread for (N − 1)× each inference's time.
// The audio worklet is not slowed.
//
// --live picks the live line («Hablando ahora…»): speech installs Chrome's on-device
// pack into e2e/.profile first (ported from the extension's prepareLive); preview
// hides Web Speech and turns on the local Whisper lane (WebGPU; its model is a
// second download from Hugging Face); none hides Web Speech with the lane off, the
// baseline for the lane's cost. Without it the profile decides. The run then
// prints, per cue, when live text first appeared after the cue's onset, and every
// stretch longer than 2.5 s in which the line was blank while a cue was spoken.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runConversation, slug, FIXTURES } from './harness.mjs';
import { score, liveScore } from './score.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
if (positional.length < 2) {
  console.error('usage: node e2e/run.mjs <learner> <other> [--condition=room|clean] [--delay=900] [--lang=en|multi] [--throttle=4] [--transcribe=<id>] [--chat=<id>] [--live=speech|preview|none] [--preview-model=<id>]');
  process.exit(2);
}
const [learner, other] = positional;
const condition = opt('condition', 'room');
const delayMs = Number(opt('delay', '900'));
const lang = opt('lang', 'en');
const cpuThrottle = Number(opt('throttle', '0'));
const transcribe = opt('transcribe', 'groq');
const chat = opt('chat', null);
const live = opt('live', null);
const previewModel = opt('preview-model', null);
if (live && !['speech', 'preview', 'none'].includes(live)) {
  console.error('[e2e] --live takes speech|preview|none');
  process.exit(2);
}
if (!['groq', 'openai', 'gemini'].includes(transcribe) || (chat && !['groq', 'openai', 'gemini', 'anthropic'].includes(chat))) {
  console.error('[e2e] --transcribe takes groq|openai|gemini; --chat also anthropic (Claude has no audio input)');
  process.exit(2);
}

const pad = (s, n) => String(s).padEnd(n);
const fmt = (v, d = 1) => (v === null || v === undefined ? '-' : v.toFixed(d));
const pct = (v) => (v === null ? '-' : `${(v * 100).toFixed(1)} %`);

const run = await runConversation({ learner, other, condition, delayMs, lang, cpuThrottle, transcribe, chat, live, previewModel });
const { perCue, totals } = score(run);
const cost = embedCost(run);
const liveLine = liveScore(run);

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

console.log(`\n${learner} (learner) with ${other} · ${condition} · stand-in delay ${delayMs} ms${cpuThrottle ? ` · CPU throttled ${cpuThrottle}×` : ''} · transcription ${transcribe} · chat ${chat || 'off'} · fixtures in ${FIXTURES}`);
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
console.log(`  provider shapes           transcription ${run.requests.length} × ${[...new Set(run.requests.map((r) => r.provider))].join(', ') || '-'} (key in its own header: ${run.requests.filter((r) => r.auth).length}/${run.requests.length}); chat ${run.chats.length} × ${[...new Set(run.chats.map((r) => r.provider))].join(', ') || '-'} (key in its own header: ${run.chats.filter((r) => r.auth).length}/${run.chats.length})`);
const modes = run.events.filter((e) => e.type === 'live-mode');
const at = (e) => (e ? `${((e.t - run.micT0) / 1000).toFixed(1)} s` : '-');
console.log(`  live line                 ${modes.map((e) => `${e.kind}${e.device ? ` (${e.device})` : ''}${e.availability ? ` [${e.availability}]` : ''} at ${at(e)}`).join(' → ') || 'never set up'}`);
console.log(`  live text after onset     ${liveLine.cuesWithLive}/${run.manifest.cues.length} cues · p50 ${fmt(liveLine.firstP50 === null ? null : liveLine.firstP50 / 1000, 2)} s · p90 ${fmt(liveLine.firstP90 === null ? null : liveLine.firstP90 / 1000, 2)} s · per cue ${liveLine.perCue.map((c) => (c.liveAfterOnsetMs === null ? '-' : (c.liveAfterOnsetMs / 1000).toFixed(1))).join(' ')}`);
console.log(`  live coverage             mean ${pct(liveLine.meanCoverage)} of each cue's words shown live (best pass during the cue)`);
console.log(`  live blank > 2.5 s        ${liveLine.blank.length} stretches, ${fmt(liveLine.blankMs / 1000)} s in all${liveLine.blank.length ? ': ' + liveLine.blank.map((b) => `cue ${b.key + 1} ${(b.from / 1000).toFixed(1)}–${(b.to / 1000).toFixed(1)} s${b.open ? ' (to its end)' : ''}`).join(', ') : ''}`);
const pv = (run.previews || []).map((p) => p.ms).sort((a, b) => a - b);
const pq = (q) => (pv.length ? pv[Math.min(pv.length - 1, Math.floor(q * pv.length))] : null);
if (pv.length) console.log(`  preview passes            ${pv.length} · p50 ${fmt(pq(0.5), 0)} ms · p90 ${fmt(pq(0.9), 0)} ms · max ${fmt(pv.at(-1), 0)} ms (retires after 2 in a row over 1500 ms)`);
console.log(`  error events              ${totals.errorEvents}`);
console.log(`  console errors            ${run.errors.length}`);
for (const e of run.errors.slice(0, 5)) console.log(`    ${e}`);

if (run.errors.length || totals.errorEvents) process.exitCode = 1;

const dir = join(FIXTURES, '..', 'results');
mkdirSync(dir, { recursive: true });
const file = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(learner)}-${slug(other)}-${condition}${cpuThrottle ? `-cpu${cpuThrottle}x` : ''}-${transcribe}${chat ? `-${chat}` : ''}${live ? `-live-${live}` : ''}.json`);
writeFileSync(file, JSON.stringify({ args: { learner, other, condition, delayMs, lang, cpuThrottle, transcribe, chat, live, previewModel }, totals, cost, liveLine, perCue, run }, null, 1));
console.log(`\nsaved ${file}`);
