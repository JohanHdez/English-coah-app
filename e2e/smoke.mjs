// Drives the real app — not a unit test — through consent → settings (a fake
// Groq key, pointed at the local mock-groq stand-in so no audio ever reaches a
// real external API) → voice enrollment → the meeting screen, over the installed
// Google Chrome via the DevTools pipe, fed by the fake microphone
// (e2e/fixtures/enroll-paulina-room.wav). It reads the stored print back out of
// IndexedDB, confirms the meeting mounts with no console errors, then exercises
// fix round 1's finding 1: opening Ajustes mid-meeting (with the fake microphone
// still feeding the running capture) must not drop the conversation, and closing
// it must return to the very same meeting, bubbles and all. Nothing under e2e/
// ships in the release zip (see tools/check.mjs's EXCLUDED_PATHS / the release
// skill), so this stays a manual/CI check, never part of the app bundle.
//
// Usage: node e2e/smoke.mjs

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chrome } from './cdp.mjs';
import { serve } from '../tools/serve.mjs';
import { startMockGroq } from './mock-groq.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PROFILE = join(HERE, '.profile');
const AUDIO = join(HERE, 'fixtures', 'enroll-paulina-room.wav');
const MODEL_LOAD_TIMEOUT_MS = 10 * 60 * 1000;
const FAKE_KEY = 'gsk_smoke_test_fake_key_0000000000';
// No real conversation manifest is needed: a single cue spanning the whole run
// matches whatever audio the mock receives, so every transcription request gets
// the same fixed, harmless text back.
const MOCK_MANIFEST = { cues: [{ key: 'smoke', start: 0, end: 24 * 60 * 60, lang: 'en', text: 'Hello, this is a smoke test.' }] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 30000, everyMs = 300, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`[smoke] timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

const bubbleCount = (chrome, session) =>
  chrome.evaluate(session, "document.querySelectorAll('.meeting .transcript .bubble').length");

async function main() {
  const server = await serve({ root: ROOT, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const mock = await startMockGroq({ manifest: MOCK_MANIFEST, delayMs: 300 });
  const chrome = await Chrome.launch({ profile: PROFILE, headless: true, audioFile: AUDIO });

  const errors = [];
  const externalRequests = [];
  let session;
  try {
    const { targetId } = await chrome.send('Target.createTarget', { url: `${base}/` });
    session = await chrome.attach(targetId);
    await chrome.send('Runtime.enable', {}, session);
    await chrome.send('Network.enable', {}, session);
    chrome.on((method, params, sid) => {
      if (sid !== session) return;
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        errors.push(`[console] ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      } else if (method === 'Runtime.exceptionThrown') {
        errors.push(`[exception] ${params.exceptionDetails.exception?.description || params.exceptionDetails.text}`);
      } else if (method === 'Network.requestWillBeSent') {
        const url = params.request?.url || '';
        if (/api\.groq\.com/.test(url)) externalRequests.push(url);
      }
    });

    // --- Consent -----------------------------------------------------------
    const h1 = await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.screen h1')?.textContent || ''"),
      { label: 'the consent screen to render' },
    );
    if (h1 !== 'Antes de empezar') throw new Error(`[smoke] expected the consent screen, got "${h1}"`);
    await chrome.evaluate(session, `
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Entendido').click();
    `);
    console.log('consent: accepted');

    // --- Settings (a fake key, groqBase pointed at the local mock) ----------
    await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.screen.settings') != null"),
      { label: 'the settings screen to render' },
    );
    await chrome.evaluate(session, `
      const input = document.querySelector('.settings input[type=password]');
      input.value = ${JSON.stringify(FAKE_KEY)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    // groqBase has no UI field by design (the controller ruling: "not shown in
    // the UI"), so it is seeded directly in storage, the same way Task 7's own
    // harness is expected to.
    await chrome.evaluate(session, `
      import('./store.js').then(async (m) => {
        const s = await m.get('settings');
        s.groqBase = ${JSON.stringify(mock.url)};
        await m.set('settings', s);
      });
    `);
    const stored = await chrome.evaluate(session, "import('./store.js').then((m) => m.get('settings'))");
    if (stored?.groqKey !== FAKE_KEY) throw new Error(`[smoke] settings.groqKey did not round-trip: ${JSON.stringify(stored)}`);
    if (stored?.groqBase !== mock.url) throw new Error(`[smoke] settings.groqBase did not round-trip: ${JSON.stringify(stored)}`);
    console.log(`settings: fake Groq key saved; groqBase pointed at the local mock (${mock.url})`);
    await chrome.evaluate(session, `
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Continuar').click();
    `);

    // --- Enrollment ----------------------------------------------------------
    await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.screen.enroll') != null"),
      { label: 'the enrollment screen to render' },
    );
    console.log('enrollment: screen rendered, waiting for the voice model to load…');
    const t0 = Date.now();
    await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.enroll button.primary')?.disabled === false"),
      { timeoutMs: MODEL_LOAD_TIMEOUT_MS, everyMs: 1000, label: 'the voice model to finish loading' },
    );
    console.log(`enrollment: model ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    await chrome.evaluate(session, "document.querySelector('.enroll button.primary').click();");
    console.log('enrollment: recording started (fake microphone: enroll-paulina-room.wav)');
    const t1 = Date.now();
    await waitFor(
      async () => {
        const print = await chrome.evaluate(session, "import('./store.js').then((m) => m.get('print'))");
        const status = await chrome.evaluate(session, "document.querySelector('.enroll .status')?.textContent || ''");
        if (status && /No te oí lo suficiente/.test(status)) throw new Error(`[smoke] enrollment reported: ${status}`);
        return print || null;
      },
      { timeoutMs: 60000, everyMs: 500, label: 'the print to be stored' },
    );
    console.log(`enrollment: finished recording + embedding in ${((Date.now() - t1) / 1000).toFixed(1)} s`);

    // --- Read the print back --------------------------------------------------
    const print = await chrome.evaluate(session, "import('./store.js').then((m) => m.get('print'))");
    if (!print) throw new Error('[smoke] store.get("print") returned nothing');
    if (!Array.isArray(print.vector) || print.vector.length !== 256) {
      throw new Error(`[smoke] print.vector should have 256 dims, got ${print.vector?.length}`);
    }
    const model = await chrome.evaluate(session, "import('../embed.js').then((m) => m.MODEL_ID)");
    if (print.model !== model) throw new Error(`[smoke] print.model "${print.model}" !== MODEL_ID "${model}"`);
    console.log(`print stored: vector length ${print.vector.length}, model "${print.model}", createdAt ${new Date(print.createdAt).toISOString()}`);

    // --- Meeting screen ----------------------------------------------------
    await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.screen.meeting') != null"),
      { label: 'the meeting screen to render' },
    );
    await sleep(1500); // let init() (model load from cache, capture, wake lock) settle
    const meetingOk = await chrome.evaluate(session, `
      !!(document.querySelector('.meeting .transcript')
        && document.querySelector('.meeting .controls .talk-toggle')
        && document.querySelector('.meeting .controls')?.textContent.includes('Terminar'))
    `);
    if (!meetingOk) throw new Error('[smoke] the meeting screen did not render its expected elements');
    console.log('meeting: screen rendered (transcript, "Estoy hablando", "Pausar"/"Terminar")');

    // --- Finding 1: Ajustes mid-meeting must not drop the conversation ------
    const t2 = Date.now();
    await waitFor(() => bubbleCount(chrome, session).then((n) => n > 0), {
      timeoutMs: 60000, everyMs: 500, label: 'the first bubble (via the local mock)',
    });
    const beforeOverlay = await bubbleCount(chrome, session);
    console.log(`meeting: first bubble after ${((Date.now() - t2) / 1000).toFixed(1)} s (${beforeOverlay} bubble(s), mock has handled ${mock.requests.length} request(s))`);

    await chrome.evaluate(session, "document.getElementById('settingsBtn').click();");
    const overlayOk = await waitFor(
      () => chrome.evaluate(session, "document.querySelector('#overlay .screen.settings') != null"),
      { label: 'the settings overlay to open' },
    );
    if (!overlayOk) throw new Error('[smoke] the settings overlay did not open');
    const meetingStillThere = await chrome.evaluate(session, "document.querySelector('.meeting') != null && !document.getElementById('overlay').hidden");
    if (!meetingStillThere) throw new Error('[smoke] the meeting screen was torn down when Ajustes opened');
    console.log('meeting: Ajustes opened as an overlay; the meeting underneath was not torn down');

    // The fake microphone keeps feeding the still-running capture while the
    // overlay sits on top: long enough to outlast one more MAX_SEG_MS (8 s)
    // forced cut, so a second bubble should land while settings are open, not
    // just the first one surviving the round trip.
    await sleep(10000);
    const duringOverlay = await bubbleCount(chrome, session);

    await chrome.evaluate(session, `
      [...document.querySelectorAll('#overlay button')].find((b) => b.textContent === 'Volver').click();
    `);
    await waitFor(
      () => chrome.evaluate(session, "document.getElementById('overlay').hidden === true"),
      { label: 'the overlay to close' },
    );
    const afterOverlay = await bubbleCount(chrome, session);
    if (afterOverlay < beforeOverlay) {
      throw new Error(`[smoke] bubble count dropped after closing Ajustes: ${beforeOverlay} -> ${afterOverlay}`);
    }
    console.log(`meeting: closed Ajustes with "Volver"; bubbles survived (${beforeOverlay} -> ${duringOverlay} during -> ${afterOverlay} after)`);

    const stillRunning = await chrome.evaluate(session, "document.querySelector('.meeting .talk-toggle')?.disabled === false");
    if (!stillRunning) throw new Error('[smoke] the meeting no longer looks like it is running after the overlay closed');
    console.log('meeting: the session is still running after the round trip through Ajustes');

    if (externalRequests.length) {
      throw new Error(`[smoke] ${externalRequests.length} request(s) reached the real Groq API: ${externalRequests.slice(0, 3).join(', ')}`);
    }
    console.log(`network: 0 requests reached api.groq.com (the mock handled ${mock.requests.length})`);

    if (errors.length) {
      console.error(`\n${errors.length} console error(s)/exception(s) during the run:`);
      for (const e of errors) console.error(' -', e);
      process.exitCode = 1;
    } else {
      console.log('\nno console errors or uncaught exceptions during the whole run.');
    }
  } finally {
    await chrome.close();
    await mock.close();
    await new Promise((r) => server.close(r));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
