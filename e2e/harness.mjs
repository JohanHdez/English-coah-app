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
export const FAKE_KEY = 'gsk_e2e_mock_key_0000000000';
const PORT = 47831;
// Mirrors ui/meeting.js's DRAIN_TIMEOUT_MS: a wait that outlasts it is a real hang.
const DRAIN_TIMEOUT_MS = 35000;

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
// exceptions, and every request that would have reached the real Groq API.
export async function openPage(chrome, base, { initScript } = {}) {
  const page = { errors: [], externalRequests: [] };
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const session = await chrome.attach(targetId);
  page.session = session;
  await chrome.send('Runtime.enable', {}, session);
  await chrome.send('Network.enable', {}, session);
  await chrome.send('Page.enable', {}, session);
  if (initScript) await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript }, session);
  chrome.on((method, params, sid) => {
    if (sid !== session) return;
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      page.errors.push(`[console] ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (method === 'Runtime.exceptionThrown') {
      page.errors.push(`[exception] ${params.exceptionDetails.exception?.description || params.exceptionDetails.text}`);
    } else if (method === 'Network.requestWillBeSent') {
      const url = params.request?.url || '';
      if (/api\.groq\.com/.test(url)) page.externalRequests.push(url);
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

export function assertNoExternal(externalRequests, label) {
  if (externalRequests.length) {
    throw new Error(`[${label}] ${externalRequests.length} request(s) reached the real Groq API: ${externalRequests.slice(0, 3).join(', ')}`);
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
  await chrome.evaluate(session, "document.querySelector('.enroll button.primary').click();");
  const t1 = Date.now();
  await waitFor(async () => {
    const status = await chrome.evaluate(session, "document.querySelector('.enroll .status')?.textContent || ''");
    if (/No te oí lo suficiente/.test(status)) throw new Error(`[e2e] enrollment reported: ${status}`);
    return chrome.evaluate(session, "import('./store.js').then((m) => m.get('print'))");
  }, { timeoutMs: 60000, everyMs: 500, label: 'the print to be stored' });
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

// One conversation through the whole app. Returns the events with timestamps, the
// fixture's manifest and the Groq stand-in's request log.
export async function runConversation({ learner, other, condition = 'room', delayMs = 900, lang = 'en', log = console.log }) {
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
          await m.set('settings', { groqKey: ${JSON.stringify(FAKE_KEY)}, lang: ${JSON.stringify(lang)}, translate: false, groqBase: ${JSON.stringify(mock.url)} });
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
      const page = await openPage(chrome, base, { initScript: MIC_CLOCK });
      const { session } = page;
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
      errors.push(...page.errors);
      external.push(...page.externalRequests);
      assertNoExternal(external, 'e2e');
      result = { name, learner, other, condition, manifest, micT0, events, requests: mock.requests.slice(), errors };
    } finally {
      await chrome.close();
    }
  } finally {
    await mock.close();
    await closeServer();
  }
  return result;
}
