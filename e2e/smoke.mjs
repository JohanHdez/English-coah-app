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

import { join } from 'node:path';
import { Chrome } from './cdp.mjs';
import { startMockGroq } from './mock-groq.mjs';
import { PROFILE, FIXTURES, sleep, waitFor, startServer, openPage, assertNoExternal, enrollViaUi, resetStorage, DRAIN_TIMEOUT_MS, FAKE_KEY } from './harness.mjs';

const AUDIO = join(FIXTURES, 'enroll-paulina-room.wav');
// No real conversation manifest is needed: a single cue spanning the whole run
// matches whatever audio the mock receives, so every transcription request gets
// the same fixed, harmless text back.
const MOCK_MANIFEST = { cues: [{ key: 'smoke', start: 0, end: 24 * 60 * 60, lang: 'en', text: 'Hello, this is a smoke test.' }] };

const bubbleCount = (chrome, session) =>
  chrome.evaluate(session, "document.querySelectorAll('.meeting .transcript .bubble').length");

async function main() {
  const { base, close: closeServer } = await startServer();
  const mock = await startMockGroq({ manifest: MOCK_MANIFEST, delayMs: 300 });
  const chrome = await Chrome.launch({ profile: PROFILE, headless: true, audioFile: AUDIO });

  let page;
  let session;
  try {
    page = await openPage(chrome, base);
    session = page.session;
    await resetStorage(chrome, session);

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
    await enrollViaUi(chrome, session, console.log);

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

    // N2: "Borrar la conversación guardada" must not offer to undo itself —
    // the running meeting re-persists the transcript after every bubble.
    const deleteTranscriptState = await chrome.evaluate(session, `
      (() => {
        const btn = [...document.querySelectorAll('#overlay button')].find((b) => b.textContent === 'Borrar la conversación guardada');
        return btn ? { disabled: btn.disabled, hint: btn.parentElement.textContent.includes('Termina la reunión para borrarla') } : null;
      })()
    `);
    if (!deleteTranscriptState?.disabled || !deleteTranscriptState?.hint) {
      throw new Error(`[smoke] "Borrar la conversación guardada" is not disabled with its hint during a meeting: ${JSON.stringify(deleteTranscriptState)}`);
    }
    console.log('meeting: "Borrar la conversación guardada" is disabled mid-meeting, with its hint shown');

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

    // N3 + N4: "Terminar" must complete (drain, bounded) and mark the saved
    // transcript finished, so a future mount does not offer it as unfinished.
    const t3 = Date.now();
    await chrome.evaluate(session, `
      [...document.querySelectorAll('.meeting .controls button')].find((b) => b.textContent === 'Terminar').click();
    `);
    await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.meeting .status')?.textContent === 'Reunión terminada.'"),
      { timeoutMs: DRAIN_TIMEOUT_MS + 5000, label: '"Terminar" to complete (drain, then "Reunión terminada.")' },
    );
    console.log(`meeting: "Terminar" completed in ${((Date.now() - t3) / 1000).toFixed(1)} s`);
    const newMeetingShown = await chrome.evaluate(session, `
      [...document.querySelectorAll('.meeting .controls button')].some((b) => b.textContent === 'Nueva reunión' && !b.hidden)
    `);
    if (!newMeetingShown) throw new Error('[smoke] "Nueva reunión" was not offered after "Terminar"');
    const savedAfterStop = await chrome.evaluate(session, "import('./store.js').then((m) => m.get('lastTranscript'))");
    if (!savedAfterStop?.finishedAt) {
      throw new Error(`[smoke] lastTranscript was not marked finished after "Terminar": ${JSON.stringify(savedAfterStop)}`);
    }
    console.log(`meeting: lastTranscript marked finished (finishedAt ${new Date(savedAfterStop.finishedAt).toISOString()}, ${savedAfterStop.entries.length} entries)`);

    assertNoExternal(page.externalRequests, 'smoke');
    console.log(`network: 0 requests reached api.groq.com (the mock handled ${mock.requests.length})`);

    if (page.errors.length) {
      console.error(`\n${page.errors.length} console error(s)/exception(s) during the run:`);
      for (const e of page.errors) console.error(' -', e);
      process.exitCode = 1;
    } else {
      console.log('\nno console errors or uncaught exceptions during the whole run.');
    }
  } finally {
    await chrome.close();
    await mock.close();
    await closeServer();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
