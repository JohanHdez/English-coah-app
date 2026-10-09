// The pieces both end-to-end drivers share: a loopback server on a stable port, a
// Chrome fed by the fake microphone, page watching that records console errors and
// any request that would leave the machine, and the whole-app conversation run
// that e2e/run.mjs scores. Nothing under e2e/ ships.
//
// A fake-microphone Chrome plays ONE file per launch, so a conversation takes two
// launches on the same profile: the first plays the learner's enrollment WAV and
// enrolls through the real enrollment screen, so the print is computed by the
// app's own code from the same audio a person would have read; the second plays the
// conversation WAV into the real meeting screen. The server keeps one port across
// both launches because IndexedDB (the print) and the Cache API (the voice model)
// are per origin.

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { Chrome } from './cdp.mjs';
import { serve } from '../tools/serve.mjs';
import { startMockGroq } from './mock-groq.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const PROFILE = join(HERE, '.profile');
export const FIXTURES = join(HERE, 'fixtures');
export const MODEL_LOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Mirrors ui/meeting.js's DRAIN_TIMEOUT_MS: a wait that outlasts it is a real hang.
export const DRAIN_TIMEOUT_MS = 35000;
export const FAKE_KEY = 'gsk_e2e_mock_key_0000000000';
// One fake key per provider, shaped like the real ones so redaction is exercised.
export const FAKE_KEYS = {
  groq: FAKE_KEY,
  openai: 'sk-e2e-mock-key-0000000000',
  gemini: 'AIzaE2eMockKey00000000000000000',
  anthropic: 'sk-ant-e2e-mock-key-0000000000',
};
const PORT = 47831;
// The one allowed exception: the app's own voice-model download. The exact hosts
// seen on 2026-10-02 (the model's metadata, then its Xet-backed CDN); a different
// CDN host fails the run by name rather than being waved through.
const MODEL_HOSTS = new Set(['huggingface.co', 'us.aws.cdn.hf.co']);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 30000, everyMs = 300, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`[e2e] timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

// A stable port keeps the origin, and with it the cached voice model, from one run
// to the next; a busy port falls back to any free one and loses only that cache.
export async function startServer() {
  let server;
  try {
    server = await serve({ root: ROOT, port: PORT });
  } catch {
    server = await serve({ root: ROOT, port: 0 });
  }
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// Opens the app and records what the run must report: console errors and
// exceptions, and every request to a host other than loopback and the model's —
// the page's own and its workers' (the embed worker is the one that downloads the
// model), attached automatically.
export async function openPage(chrome, base, { initScript, cpuThrottle } = {}) {
  const page = { errors: [], externalRequests: [], throttled: [] };
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const session = await chrome.attach(targetId);
  page.session = session;
  const watched = new Set([session]);
  chrome.on((method, params) => {
    if (method !== 'Target.attachedToTarget' || params.targetInfo?.type === 'page') return;
    const child = params.sessionId;
    watched.add(child);
    chrome.send('Network.enable', {}, child).catch(() => {});
    chrome.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child).catch(() => {});
    if (cpuThrottle) {
      chrome.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle }, child).then(
        () => page.throttled.push(params.targetInfo.type),
        (err) => page.throttled.push(`${params.targetInfo.type}: ${err.message}`),
      );
    }
  });
  await chrome.send('Runtime.enable', {}, session);
  await chrome.send('Network.enable', {}, session);
  await chrome.send('Page.enable', {}, session);
  await chrome.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session);
  if (cpuThrottle) await chrome.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle }, session);
  if (initScript) await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript }, session);
  chrome.on((method, params, sid) => {
    if (!watched.has(sid)) return;
    if (method === 'Network.requestWillBeSent') {
      const url = params.request?.url || '';
      if (/^https?:/.test(url)) {
        const host = new URL(url).hostname;
        if (host !== '127.0.0.1' && !MODEL_HOSTS.has(host)) page.externalRequests.push(url);
      }
      return;
    }
    if (sid !== session) return;
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      page.errors.push(`[console] ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (method === 'Runtime.exceptionThrown') {
      page.errors.push(`[exception] ${params.exceptionDetails.exception?.description || params.exceptionDetails.text}`);
    }
  });
  await chrome.send('Page.navigate', { url: `${base}/` }, session);
  return page;
}

// The profile persists across runs (it carries the cached voice model), and so does
// the origin's IndexedDB: a run that starts from the consent screen clears it first.
export async function resetStorage(chrome, session) {
  await waitFor(() => chrome.evaluate(session, "document.readyState === 'complete'"), { label: 'the page to load' });
  await chrome.evaluate(session, "import('./store.js').then((m) => Promise.all(['consent', 'settings', 'print', 'lastTranscript'].map((k) => m.del(k))))");
  await chrome.send('Page.reload', {}, session);
}

// A real mouse press and release at the element's centre: unlike element.click()
// from a script, it carries the user activation an AudioContext needs to run.
export async function tap(chrome, session, selector) {
  const point = await chrome.evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.hidden || el.disabled) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!point) throw new Error(`[e2e] nothing to tap at ${selector}`);
  await chrome.send('Page.bringToFront', {}, session);
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, session);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await chrome.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }, session);
  }
}

// Taps «Empezar reunión» as soon as the meeting screen offers it.
export async function startMeeting(chrome, session) {
  await waitFor(
    () => chrome.evaluate(session, "(() => { const b = document.querySelector('.meeting .start-meeting'); return !!b && !b.hidden; })()"),
    { label: '«Empezar reunión»' },
  );
  await tap(chrome, session, '.meeting .start-meeting');
}

export function assertNoExternal(externalRequests, label) {
  if (externalRequests.length) {
    throw new Error(`[${label}] ${externalRequests.length} request(s) left the machine (only 127.0.0.1 and the model hosts are allowed): ${externalRequests.slice(0, 3).join(', ')}`);
  }
}

// Waits for the enrollment screen's voice model, records the fake microphone's
// WAV through the real screen and returns the stored print.
export async function enrollViaUi(chrome, session, log = () => {}) {
  await waitFor(() => chrome.evaluate(session, "document.querySelector('.screen.enroll') != null"), { label: 'the enrollment screen to render' });
  log('enrollment: screen rendered, waiting for the voice model to load…');
  const t0 = Date.now();
  await waitFor(
    () => chrome.evaluate(session, "document.querySelector('.enroll button.primary')?.disabled === false"),
    { timeoutMs: MODEL_LOAD_TIMEOUT_MS, everyMs: 1000, label: 'the voice model to finish loading' },
  );
  log(`enrollment: model ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await tap(chrome, session, '.enroll button.primary');
  const t1 = Date.now();
  try {
    await waitFor(async () => {
      const status = await chrome.evaluate(session, "document.querySelector('.enroll .status')?.textContent || ''");
      if (/No te oí lo suficiente|\[micrófono\]|\[huella\]/.test(status)) throw new Error(`[e2e] enrollment reported: ${status}`);
      return chrome.evaluate(session, "import('./store.js').then((m) => m.get('print'))");
    }, { timeoutMs: 90000, everyMs: 500, label: 'the print to be stored' });
  } catch (err) {
    const state = await chrome.evaluate(session, `JSON.stringify({ screen: document.querySelector('.screen')?.className, status: document.querySelector('.status')?.textContent, countdown: document.querySelector('.enroll .countdown')?.textContent, buttons: [...document.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent) })`).catch(() => '?');
    err.message += ` — page: ${state}`;
    throw err;
  }
  log(`enrollment: finished recording + embedding in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  return chrome.evaluate(session, "import('./store.js').then((m) => m.get('print'))");
}

export const slug = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Records when the page's microphone stream resolved: the fixture's time zero.
const MIC_CLOCK = `(() => {
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => { const s = await gum(c); window.__micT0 ??= Date.now(); return s; };
})();`;

// The settings a run starts from: every provider pointed at the stand-in (the
// loopback overrides providers.js honours), a fake key for the chosen ones.
function harnessSettings({ transcribe, chat, lang, mockUrl, live }) {
  const chatProvider = chat || 'groq';
  return {
    transcribeProvider: transcribe,
    chatProvider,
    keys: { [transcribe]: FAKE_KEYS[transcribe], [chatProvider]: FAKE_KEYS[chatProvider] },
    lang,
    translate: !!chat,
    livePreview: live !== 'none',
    groqBase: mockUrl,
    bases: { openai: mockUrl, gemini: mockUrl, anthropic: mockUrl },
  };
}

// With a chat provider named, translation is on and the browser's own Translator
// is hidden, so every translation goes through that provider's stand-in instead
// of an on-device model the headless profile would try to download.
const NO_TRANSLATOR = 'delete window.Translator;';

// --live=preview and --live=none measure a browser without on-device recognition.
const NO_SPEECH = 'delete window.SpeechRecognition; delete window.webkitSpeechRecognition;';

// Ported from the extension's prepareLive(): what a real install has and a
// throwaway profile does not is the on-device Web Speech pack. It only downloads
// behind a user activation, which the protocol grants the script; once installed
// it stays in e2e/.profile. A pack that will not install is reported, not fatal.
async function prepareLive(chrome, session, lang) {
  return chrome.evaluate(session, `(async () => {
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!SR || typeof SR.available !== 'function') return 'speech: unsupported';
    const before = await SR.available({ langs: ['${lang}'], processLocally: true });
    if (before === 'available') return 'speech: available';
    const ok = await SR.install({ langs: ['${lang}'], processLocally: true });
    return 'speech: ' + before + ' → install ' + ok + ' → ' + await SR.available({ langs: ['${lang}'], processLocally: true });
  })()`, { userGesture: true }).catch((e) => `speech: ${e.message}`);
}

// One conversation through the whole app. Returns the events with timestamps, the
// fixture's manifest and the stand-in's request logs.
// `live`: null leaves the profile as it is; 'speech' installs the on-device pack
// first; 'preview' hides Web Speech and turns the local Whisper lane on; 'none'
// hides Web Speech with the lane off — the baseline the lane is compared against.
export async function runConversation({ learner, other, condition = 'room', delayMs = 900, lang = 'en', cpuThrottle = 0, transcribe = 'groq', chat = null, live = null, previewModel = null, log = console.log }) {
  const name = `${slug(learner)}-${slug(other)}-${condition}`;
  const enrollWav = join(FIXTURES, `enroll-${slug(learner)}-${condition}.wav`);
  const convoWav = join(FIXTURES, `${name}.wav`);
  const manifestPath = join(FIXTURES, `${name}.json`);
  for (const f of [enrollWav, convoWav, manifestPath]) {
    if (!existsSync(f)) throw new Error(`[e2e] missing fixture ${f} (node e2e/fixtures.mjs)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const { base, close: closeServer } = await startServer();
  const mock = await startMockGroq({ manifest, delayMs, wav: readFileSync(convoWav) });
  const errors = [];
  const external = [];
  let result;
  try {
    const first = await Chrome.launch({ profile: PROFILE, headless: true, audioFile: enrollWav });
    try {
      const page = await openPage(first, base);
      const { session } = page;
      await waitFor(() => first.evaluate(session, "document.readyState === 'complete'"), { label: 'the page to load' });
      await first.evaluate(session, `
        import('./store.js').then(async (m) => {
          await m.set('consent', true);
          await m.set('settings', ${JSON.stringify(harnessSettings({ transcribe, chat, lang, mockUrl: mock.url, live }))});
          await m.del('print');
          await m.del('lastTranscript');
        });
      `);
      await first.send('Page.reload', {}, session);
      await enrollViaUi(first, session, log);
      errors.push(...page.errors);
      external.push(...page.externalRequests);
    } finally {
      await first.close();
    }

    const chrome = await Chrome.launch({ profile: PROFILE, headless: true, audioFile: convoWav });
    try {
      // window.__ec is created by app.js; the slowdown is read when the meeting's
      // worker starts, after the app has run.
      const slow = cpuThrottle ? `;addEventListener('DOMContentLoaded', () => { if (window.__ec) window.__ec.cpuSlowdown = ${cpuThrottle}; });` : '';
      const model = previewModel ? `;addEventListener('DOMContentLoaded', () => { if (window.__ec) window.__ec.previewModel = ${JSON.stringify(previewModel)}; });` : '';
      const hide = live === 'preview' || live === 'none' ? NO_SPEECH : '';
      const page = await openPage(chrome, base, { initScript: MIC_CLOCK + slow + model + hide + (chat ? NO_TRANSLATOR : ''), cpuThrottle });
      const { session } = page;
      if (cpuThrottle) log(`meeting: CPU throttled ${cpuThrottle}×`);
      if (live === 'speech') {
        await waitFor(() => chrome.evaluate(session, "document.readyState === 'complete'"), { label: 'the page to load' });
        log(`meeting: ${await prepareLive(chrome, session, lang === 'es' ? 'es-ES' : 'en-US')}`);
      }
      await startMeeting(chrome, session);
      await waitFor(
        () => chrome.evaluate(session, "document.querySelector('.screen.meeting .controls .talk-toggle')?.disabled === false"),
        { timeoutMs: MODEL_LOAD_TIMEOUT_MS, everyMs: 500, label: 'the meeting to start recording' },
      );
      const micT0 = await waitFor(() => chrome.evaluate(session, 'window.__micT0 || 0'), { timeoutMs: 10000, everyMs: 50, label: 'the microphone stream' });
      mock.setT0(micT0);
      log(`meeting: recording; the fixture lasts ${manifest.duration} s`);
      await sleep(Math.max(0, (manifest.duration + 10) * 1000 - (Date.now() - micT0)));
      await chrome.evaluate(session, "[...document.querySelectorAll('.meeting .controls button')].find((b) => b.textContent === 'Terminar').click();");
      await waitFor(
        () => chrome.evaluate(session, "document.querySelector('.meeting .status')?.textContent === 'Reunión terminada.'"),
        { timeoutMs: DRAIN_TIMEOUT_MS + 5000, label: '"Terminar" to complete' },
      );
      const events = await chrome.evaluate(session, 'window.__ec.events');
      const embeds = await chrome.evaluate(session, 'window.__ec.embeds');
      const previews = await chrome.evaluate(session, 'window.__ec.previews');
      errors.push(...page.errors);
      external.push(...page.externalRequests);
      assertNoExternal(external, 'e2e');
      if (cpuThrottle) {
        log(`meeting: DevTools throttling: page yes; ${page.throttled.join('; ') || 'no other target'}`);
        log(`meeting: embed worker slowed ${await chrome.evaluate(session, 'window.__ec.cpuSlowdown')}× by holding its thread (DevTools cannot throttle a worker)`);
      }
      const misrouted = [...mock.requests, ...mock.chats].filter((r) => !r.auth || r.provider !== (mock.chats.includes(r) ? chat : transcribe));
      for (const r of misrouted) errors.push(`[e2e] request ${r.n} went to ${r.provider} (auth in its own header: ${r.auth})`);
      result = { name, learner, other, condition, cpuThrottle, transcribe, chat, live, manifest, micT0, events, embeds, previews, requests: mock.requests.slice(), chats: mock.chats.slice(), errors };
    } finally {
      await chrome.close();
    }
  } finally {
    await mock.close();
    await closeServer();
  }
  return result;
}
