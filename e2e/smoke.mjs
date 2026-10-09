// Drives the real app — not a unit test — through consent → settings (a fake
// Groq key, pointed at the local mock-groq stand-in so no audio ever reaches a
// real external API) → voice enrollment → the meeting screen, over the installed
// Google Chrome via the DevTools pipe, fed by the fake microphone
// (e2e/fixtures/enroll-paulina-room.wav). It reads the stored print back out of
// IndexedDB, confirms the meeting mounts with no console errors, then exercises
// fix round 1's finding 1: opening Ajustes mid-meeting (with the fake microphone
// still feeding the running capture) must not drop the conversation, and closing
// it must return to the very same meeting, bubbles and all. The meeting starts
// on a real tap of «Empezar reunión» (no autoplay flag), and a capture that dies
// while the page is away (simulated: the tracks are stopped, then the page is
// told it is visible again) must be reported and resumed into the same meeting
// with «Reanudar». The coach panel is exercised mid-meeting at 360 px: a phrase
// copied to the clipboard, a note added, the profile and context typed, «Respuesta»
// answered by the stand-in and rendered with its key term in <b>, and the friendly
// error for a missing key. Nothing under e2e/
// ships in the release zip (see tools/check.mjs's EXCLUDED_PATHS / the release
// skill), so this stays a manual/CI check, never part of the app bundle.
//
// Usage: node e2e/smoke.mjs

import { join } from 'node:path';
import { Chrome } from './cdp.mjs';
import { startMockGroq } from './mock-groq.mjs';
import { PROFILE, FIXTURES, sleep, waitFor, startServer, openPage, assertNoExternal, enrollViaUi, resetStorage, startMeeting, tap, DRAIN_TIMEOUT_MS, FAKE_KEY } from './harness.mjs';

const AUDIO = join(FIXTURES, 'enroll-paulina-room.wav');
// No real conversation manifest is needed: a single cue spanning the whole run
// matches whatever audio the mock receives, so every transcription request gets
// the same fixed, harmless text back.
const MOCK_MANIFEST = { cues: [{ key: 'smoke', start: 0, end: 24 * 60 * 60, lang: 'en', text: 'Hello, this is a smoke test.' }] };

// Keeps every microphone stream the page opens, so the run can end them the way
// a phone's OS does when the app is backgrounded.
const KEEP_STREAMS = `(() => {
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  window.__streams = [];
  window.__hold = null;
  md.getUserMedia = async (c) => {
    const hold = window.__hold;
    let held = false;
    if (hold && hold.left > 0) { hold.left--; hold.taken = true; held = true; await hold.promise; }
    const s = await gum(c);
    s.__late = held;
    window.__streams.push(s);
    return s;
  };
})();`;

// Headless Chrome refuses the screen Wake Lock, so the app's own warning about it
// is as good as «Grabando…» here: both mean capture was checked and is running.
const RECORDING = /^(Grabando…|La pantalla puede apagarse y cortar el micrófono\. Mantén la app abierta\.)$/;

const statusText = (chrome, session) => chrome.evaluate(session, "document.querySelector('.meeting .status')?.textContent || ''");

const bubbleCount = (chrome, session) =>
  chrome.evaluate(session, "document.querySelectorAll('.meeting .transcript .bubble').length");

async function main() {
  const { base, close: closeServer } = await startServer();
  const mock = await startMockGroq({ manifest: MOCK_MANIFEST, delayMs: 300 });
  const chrome = await Chrome.launch({ profile: PROFILE, headless: true, audioFile: AUDIO });

  let page;
  let session;
  try {
    page = await openPage(chrome, base, { initScript: KEEP_STREAMS });
    session = page.session;
    await resetStorage(chrome, session);

    // --- Consent -----------------------------------------------------------
    const h1 = await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.screen h1')?.textContent || ''"),
      { label: 'the consent screen to render' },
    );
    if (h1 !== 'Antes de empezar') throw new Error(`[smoke] expected the consent screen, got "${h1}"`);
    const consentText = await chrome.evaluate(session, "document.querySelector('.screen.consent')?.textContent || ''");
    if (!/audio de la reunión se envía a Groq/.test(consentText) || !/texto de la conversación se envía a Groq/.test(consentText)) {
      throw new Error(`[smoke] the consent screen does not say who receives the audio and the text: ${consentText}`);
    }
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
    if (stored?.keys?.groq !== FAKE_KEY) throw new Error(`[smoke] settings.keys.groq did not round-trip: ${JSON.stringify({ ...stored, keys: Object.keys(stored?.keys || {}) })}`);
    if (stored?.groqBase !== mock.url) throw new Error(`[smoke] settings.groqBase did not round-trip`);
    const pickers = await chrome.evaluate(session, `(() => {
      const [audio, text] = [...document.querySelectorAll('.settings select')].slice(0, 2);
      return {
        audio: [...audio.options].map((o) => o.value),
        text: [...text.options].map((o) => o.value),
        note: [...document.querySelectorAll('.settings .hint')].some((p) => p.textContent === 'Claude no recibe audio: úsalo para la traducción y el coach.'),
        routing: document.querySelector('.settings .routing')?.textContent || '',
      };
    })()`);
    if (pickers.audio.includes('anthropic') || !pickers.text.includes('anthropic') || !pickers.note) throw new Error(`[smoke] the provider pickers are wrong: ${JSON.stringify(pickers)}`);
    if (!/audio de la reunión se envía a Groq/.test(pickers.routing)) throw new Error(`[smoke] settings do not say who receives the audio: ${pickers.routing}`);
    console.log(`settings: fake Groq key saved; groqBase pointed at the local mock (${mock.url})`);
    await chrome.evaluate(session, `
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Continuar').click();
    `);

    // --- Enrollment ----------------------------------------------------------
    await enrollViaUi(chrome, session, console.log);
    const streamsAfterEnroll = await chrome.evaluate(session, 'window.__streams.length');

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
    await sleep(1500); // time enough for a meeting that started on its own to open the microphone
    const autoStarted = await chrome.evaluate(session, 'window.__streams.length') > streamsAfterEnroll;
    if (autoStarted) throw new Error('[smoke] the meeting opened the microphone before any tap');
    await startMeeting(chrome, session);
    await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.meeting .talk-toggle')?.disabled === false"),
      { timeoutMs: 60000, label: 'recording after the «Empezar reunión» tap' },
    );
    const recording = await statusText(chrome, session);
    if (!RECORDING.test(recording)) throw new Error(`[smoke] expected «Grabando…» after the tap, got "${recording}"`);
    console.log(`meeting: started on a real tap of «Empezar reunión» (no autoplay flag); status "${recording}"`);
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


    // Phase 2, task 5: the coach panel at a phone's width, in the middle of the
    // running meeting.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile: false }, session);
    await chrome.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: base });
    const readClipboard = () => chrome.evaluate(session, 'navigator.clipboard.readText()');
    const size = (selector) => chrome.evaluate(session, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { w: r.width, h: r.height } : null; })()`);

    const replySize = await size('.meeting .reply-btn');
    if (!replySize || replySize.h < 44) throw new Error(`[smoke] «Respuesta» is not a big tap target: ${JSON.stringify(replySize)}`);
    const convoBefore = await size('.meeting .transcript');

    await tap(chrome, session, '.coach-tab[data-tab=phrases]');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-body .chip') != null"), { label: 'the phrase chips' });
    const chipSize = await size('.coach-body .chip');
    const panelH = (await size('.coach-panel')).h;
    if (chipSize.h < 44) throw new Error(`[smoke] a phrase chip is under 44 px: ${JSON.stringify(chipSize)}`);
    if (panelH > 740 / 2 + 1) throw new Error(`[smoke] the coach panel is taller than half the screen: ${panelH}`);
    const chipText = await chrome.evaluate(session, "document.querySelector('.coach-body .chip b').textContent");
    await tap(chrome, session, '.coach-body .chip');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.meeting .toast')?.hidden === false && document.querySelector('.meeting .toast').textContent === 'Copiado'"), { label: 'the «Copiado» toast' });
    const copied = await readClipboard();
    if (copied !== chipText) throw new Error(`[smoke] the chip did not reach the clipboard: "${copied}" vs "${chipText}"`);
    const overflow = await chrome.evaluate(session, 'document.documentElement.scrollWidth > document.documentElement.clientWidth');
    if (overflow) throw new Error('[smoke] the page scrolls sideways at 360 px');
    console.log(`coach: chip «${chipText}» copied to the clipboard; chip ${Math.round(chipSize.h)} px tall, panel ${Math.round(panelH)} px of 740, no sideways scroll at 360 px`);

    await tap(chrome, session, '.coach-tab[data-tab=notes]');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-body .notes') != null"), { label: 'the notes tab' });
    await chrome.evaluate(session, `(() => {
      const f = document.querySelector('.coach-body .add-form');
      const t = f.querySelector('input'); t.value = 'Angular'; t.dispatchEvent(new Event('input', { bubbles: true }));
      const b = f.querySelector('textarea'); b.value = 'Signals replace zone.js change detection'; b.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await tap(chrome, session, '.coach-body .add-form button[type=submit]');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-body .note.open .note-text')?.textContent === 'Signals replace zone.js change detection'"), { label: 'the new note, open' });
    const noteStored = await chrome.evaluate(session, "import('./store.js').then((m) => m.get('settings')).then((s) => (s.notes || []).map((n) => n.title))");
    if (noteStored.join() !== 'Angular') throw new Error(`[smoke] the note was not stored: ${JSON.stringify(noteStored)}`);
    const notesTab = await chrome.evaluate(session, "document.querySelector('.coach-tab[data-tab=notes]').textContent");
    if (notesTab !== 'Notas 1') throw new Error(`[smoke] the Notas tab does not count the note: "${notesTab}"`);
    console.log('coach: a note added mid-meeting is shown open, stored, and counted in the tab');

    await tap(chrome, session, '.coach-tab[data-tab=context]');
    await waitFor(() => chrome.evaluate(session, "document.querySelectorAll('.coach-body textarea').length === 2"), { label: 'the profile and context fields' });
    await chrome.evaluate(session, `(() => {
      const [p, c] = document.querySelectorAll('.coach-body textarea');
      p.value = 'PROFILE-MARK frontend developer, five years of Angular'; p.dispatchEvent(new Event('input', { bubbles: true }));
      c.value = 'CONTEXT-MARK technical interview about signals'; c.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await tap(chrome, session, '.coach-tab[data-tab=context]'); // collapses the panel
    const convoAfter = await size('.meeting .transcript');
    if (convoAfter.h < convoBefore.h - 1) throw new Error(`[smoke] the conversation shrank with the panel collapsed: ${convoBefore.h} -> ${convoAfter.h}`);

    // «Respuesta»: the suggested answer takes the panel's place.
    const chatsBefore = mock.chats.length;
    const tReply = Date.now();
    await tap(chrome, session, '.meeting .reply-btn');
    const pending = await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-reply .reply-status')?.textContent || ''"), { timeoutMs: 5000, everyMs: 20, label: '«Pensando…»' });
    if (pending !== 'Pensando…') throw new Error(`[smoke] expected «Pensando…», got "${pending}"`);
    const busy = await chrome.evaluate(session, "document.querySelector('.meeting .reply-btn').disabled");
    if (!busy) throw new Error('[smoke] «Respuesta» can be tapped again while one request is in flight');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-reply .reply-item.answer') != null"), { timeoutMs: 20000, everyMs: 20, label: 'the suggested answer' });
    const replyMs = Date.now() - tReply;
    const rendered = await chrome.evaluate(session, `(() => {
      const a = document.querySelector('.coach-reply .reply-item.answer .reply-en');
      return { text: a.textContent, bold: [...a.querySelectorAll('b')].map((b) => b.textContent), ideas: document.querySelectorAll('.coach-reply .reply-item:not(.answer)').length, stars: a.textContent.includes('**') };
    })()`);
    if (rendered.bold.join() !== 'Angular' || rendered.stars || rendered.ideas !== 2) throw new Error(`[smoke] the suggested answer rendered wrong: ${JSON.stringify(rendered)}`);
    const asked = mock.chats.slice(chatsBefore).find((c) => /Conversation so far:/.test(c.user));
    if (!asked || !asked.user.includes('PROFILE-MARK') || !asked.user.includes('CONTEXT-MARK')) throw new Error('[smoke] the request did not carry the profile and the context just typed');
    await tap(chrome, session, '.coach-reply .reply-item.answer');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-reply .reply-item.answer.copied') != null"), { label: 'the answer copied' });
    if ((await readClipboard()) !== 'I mostly work with Angular every day.') throw new Error('[smoke] the copied answer kept its ** markers or was not copied');
    await tap(chrome, session, '.coach-reply .reply-close');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-reply').hidden && !document.querySelector('.coach-tabs').hidden"), { label: 'the panel back to its tabs' });
    console.log(`coach: «Respuesta» -> «Pensando…» -> answer with "Angular" in <b>, 2 ideas, copied without markers; ${replyMs} ms from tap to render against the stand-in (its chat delay is ${Math.round(300 / 3)} ms); profile and context reached the request`);

    // Translation, per bubble, through the same stand-in and the app's own translate.js.
    const times = await chrome.evaluate(session, `(async () => {
      // A fresh copy of translate.js with the browser's own Translator hidden, so the
      // chat provider's stand-in is what answers.
      const { loadSettings } = await import('./store.js');
      const settings = await loadSettings();
      const saved = window.Translator;
      delete window.Translator;
      try {
        const { toSpanish } = await import('./translate.js?chat-only');
        const out = [];
        for (let i = 0; i < 9; i++) {
          const t0 = performance.now();
          const es = await toSpanish('That is the best part of the conversation number ' + i, settings);
          out.push({ ms: Math.round(performance.now() - t0), ok: es.startsWith('[es]') });
        }
        return out;
      } finally {
        if (saved) window.Translator = saved;
      }
    })()`);
    if (times.some((x) => !x.ok)) throw new Error(`[smoke] a translation did not come back through the stand-in: ${JSON.stringify(times)}`);
    const sorted = times.map((x) => x.ms).sort((a, b) => a - b);
    console.log(`translation: 9 bubbles through the stand-in, p50 ${sorted[4]} ms, max ${sorted[8]} ms (stand-in chat delay ${Math.round(300 / 3)} ms; a real model's time is not measured here)`);
    await chrome.send('Emulation.clearDeviceMetricsOverride', {}, session);

    // Final review, finding 2: capture that dies in the background is reported on
    // return, and «Reanudar» restarts it into the same meeting.
    const beforeLoss = await bubbleCount(chrome, session);
    await chrome.evaluate(session, `
      window.__streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      document.dispatchEvent(new Event('visibilitychange'));
    `);
    const lost = await statusText(chrome, session);
    const resumeShown = await chrome.evaluate(session, "document.querySelector('.meeting .resume-capture')?.hidden === false");
    if (!/La captura se detuvo mientras la app estaba en segundo plano/.test(lost) || !resumeShown) {
      throw new Error(`[smoke] a dead capture was not reported on return: status "${lost}", «Reanudar» shown: ${resumeShown}`);
    }
    console.log(`meeting: capture stopped behind the page's back -> "${lost}" with «Reanudar»`);
    await tap(chrome, session, '.meeting .resume-capture');
    await waitFor(() => statusText(chrome, session).then((t) => RECORDING.test(t)), { timeoutMs: 15000, label: '«Grabando…» after «Reanudar»' });
    await waitFor(() => bubbleCount(chrome, session).then((n) => n > beforeLoss), {
      timeoutMs: 60000, everyMs: 500, label: 'a new bubble after «Reanudar»',
    });
    const afterResume = await bubbleCount(chrome, session);
    console.log(`meeting: «Reanudar» restarted capture into the same meeting (${beforeLoss} -> ${afterResume} bubbles, ${await chrome.evaluate(session, 'window.__streams.length')} streams opened)`);

    // Phase 2, task 1: capture is lost again and the next microphone request is
    // held (as a permission prompt would hold it). «Reanudar», then «Terminar»,
    // then «Nueva reunión» all happen before it is granted; when it is, that
    // stale stream must be ended and must not become the new meeting's capture.
    await chrome.evaluate(session, `
      window.__streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      document.dispatchEvent(new Event('visibilitychange'));
      window.__hold = { left: 1, taken: false, released: false, promise: new Promise((r) => { window.__releaseGum = () => { window.__hold.released = true; r(); }; }) };
    `);
    await tap(chrome, session, '.meeting .resume-capture');
    await waitFor(() => chrome.evaluate(session, 'window.__hold.taken'), { label: 'the held microphone request' });
    const t3 = Date.now();
    await tap(chrome, session, '.meeting .controls .stop-meeting');
    await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.meeting .status')?.textContent === 'Reunión terminada.'"),
      { timeoutMs: DRAIN_TIMEOUT_MS + 5000, label: '"Terminar" to complete (drain, then "Reunión terminada.")' },
    );
    console.log(`meeting: "Terminar" completed in ${((Date.now() - t3) / 1000).toFixed(1)} s`);
    const newMeetingShown = await chrome.evaluate(session, `
      [...document.querySelectorAll('.meeting .controls button')].some((b) => b.textContent === 'Nueva reunión' && !b.hidden)
    `);
    if (!newMeetingShown) throw new Error('[smoke] "Nueva reunión" was not offered after "Terminar"');
    const uploadsAtStop = mock.requests.length;
    await sleep(3000);
    if (mock.requests.length !== uploadsAtStop) {
      throw new Error(`[smoke] ${mock.requests.length - uploadsAtStop} upload(s) reached the stand-in after «Terminar»`);
    }
    const savedAfterStop = await chrome.evaluate(session, "import('./store.js').then((m) => m.get('lastTranscript'))");
    if (!savedAfterStop?.finishedAt) {
      throw new Error(`[smoke] lastTranscript was not marked finished after "Terminar": ${JSON.stringify(savedAfterStop)}`);
    }
    console.log(`meeting: lastTranscript marked finished (finishedAt ${new Date(savedAfterStop.finishedAt).toISOString()}, ${savedAfterStop.entries.length} entries)`);


    // The coach's errors are the friendly Spanish ones, staged [coach]: a missing key
    // points at Ajustes.
    const setGroqKey = async (value) => {
      await chrome.evaluate(session, "document.getElementById('settingsBtn').click();");
      await waitFor(() => chrome.evaluate(session, "document.querySelector('#overlay .screen.settings input[type=password]') != null"), { label: 'the settings overlay' });
      await chrome.evaluate(session, `(() => {
        const i = document.querySelector('#overlay .settings input[type=password]');
        i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await chrome.evaluate(session, "[...document.querySelectorAll('#overlay button')].find((b) => b.textContent === 'Volver').click();");
    };
    await setGroqKey('');
    await tap(chrome, session, '.meeting .reply-btn');
    const keyError = await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-reply .reply-status.error')?.textContent || ''"), { timeoutMs: 10000, label: 'the missing-key error' });
    if (keyError !== '[coach] Falta la API key de Groq (ábrela en Ajustes).') throw new Error(`[smoke] unexpected coach error: "${keyError}"`);
    await tap(chrome, session, '.coach-reply .reply-close');
    await setGroqKey(FAKE_KEY);
    console.log(`coach: with no key, «Respuesta» says "${keyError}"`);

    // The closing report: the stand-in answers with Markdown carrying a <script> and an
    // <img onerror>. Headings and lists must be elements; the hostile HTML must be text.
    const reportBtnShown = await chrome.evaluate(session, "[...document.querySelectorAll('.meeting .controls button')].some((b) => b.textContent === 'Generar informe' && !b.hidden)");
    if (!reportBtnShown) throw new Error('[smoke] «Generar informe» was not offered after «Terminar»');
    await setGroqKey('');
    await tap(chrome, session, '.meeting .report-btn');
    const reportKeyError = await waitFor(() => chrome.evaluate(session, "document.querySelector('.report .report-status.error')?.textContent || ''"), { timeoutMs: 10000, label: 'the report missing-key error' });
    if (reportKeyError !== '[coach] Falta la API key de Groq (ábrela en Ajustes).') throw new Error(`[smoke] unexpected report error: "${reportKeyError}"`);
    await setGroqKey(FAKE_KEY);
    const reportChatsBefore = mock.chats.length;
    const tReport = Date.now();
    await tap(chrome, session, '.meeting .report-btn');
    const busyReport = await chrome.evaluate(session, "document.querySelector('.meeting .report-btn').disabled");
    if (!busyReport) throw new Error('[smoke] «Generar informe» can be tapped again while one request is in flight');
    await waitFor(() => chrome.evaluate(session, "document.querySelectorAll('.report .report-body h2').length > 0"), { timeoutMs: 20000, everyMs: 20, label: 'the report' });
    const reportMs = Date.now() - tReport;
    const reportDom = await chrome.evaluate(session, `(() => {
      const b = document.querySelector('.report .report-body');
      return {
        h2: b.querySelectorAll('h2').length, h3: b.querySelectorAll('h3').length,
        ul: b.querySelectorAll('ul > li').length, ol: b.querySelectorAll('ol > li').length,
        strong: [...b.querySelectorAll('strong')].map((n) => n.textContent),
        scripts: b.querySelectorAll('script').length, imgs: b.querySelectorAll('img').length,
        pwned: window.__pwned === 1, text: b.textContent,
        table: { th: b.querySelectorAll('table thead th').length, rows: b.querySelectorAll('table tbody tr').length, boldCell: b.querySelector('td strong')?.textContent, bTags: b.querySelectorAll('td b').length },
        pageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    })()`);
    if (reportDom.h2 !== 1 || reportDom.h3 !== 1 || reportDom.ul !== 2 || reportDom.ol !== 2
      || !reportDom.strong.includes('Angular') || !reportDom.strong.includes('phrasal verbs')) {
      throw new Error(`[smoke] the report did not render as elements: ${JSON.stringify(reportDom)}`);
    }
    if (reportDom.table.th !== 3 || reportDom.table.rows !== 2 || reportDom.table.boldCell !== 'verbo' || reportDom.table.bTags || reportDom.pageScroll) {
      throw new Error(`[smoke] the report table did not render as a <table>: ${JSON.stringify(reportDom.table)} pageScroll=${reportDom.pageScroll}`);
    }
    if (reportDom.scripts || reportDom.imgs || reportDom.pwned
      || !reportDom.text.includes('<script>window.__pwned = 1</script>') || !reportDom.text.includes('<img src=x onerror=')) {
      throw new Error(`[smoke] HTML in the report did not stay text: ${JSON.stringify(reportDom)}`);
    }
    const reportChats = mock.chats.slice(reportChatsBefore);
    if (reportChats.length !== 1) throw new Error(`[smoke] one report request expected, saw ${reportChats.length}`);
    const storedReport = await chrome.evaluate(session, "import('./store.js').then((m) => m.get('lastTranscript'))");
    if (!storedReport?.report?.includes('## Resumen')) throw new Error('[smoke] the report was not storedReport with the transcript');
    const download = await chrome.evaluate(session, `(() => {
      const urls = [];
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => { urls.push([blob.type, blob.size]); return orig.call(URL, blob); };
      document.querySelector('.report .report-download').click();
      return urls;
    })()`);
    if (download.length !== 1 || !download[0][0].startsWith('text/markdown') || download[0][1] < 20) throw new Error(`[smoke] «Descargar .md» did not build a local Blob: ${JSON.stringify(download)}`);
    await chrome.evaluate(session, "Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })");
    await tap(chrome, session, '.report .report-copy');
    const copyMsg = await waitFor(() => chrome.evaluate(session, "document.querySelector('.meeting .toast:not([hidden])')?.textContent || ''"), { timeoutMs: 3000, everyMs: 20, label: 'the clipboard message' });
    if (!/^No se pudo copiar/.test(copyMsg)) throw new Error(`[smoke] unexpected clipboard message: "${copyMsg}"`);
    console.log(`report: ${reportMs} ms from tap to render; ${reportDom.h2} h2, ${reportDom.h3} h3, ${reportDom.ul} bullets, ${reportDom.ol} numbered, bold ${JSON.stringify(reportDom.strong)}; a 3-column <table> with a bold cell and <b> as text, no page scroll; <script> and <img onerror> stayed text; stored with the transcript; Blob built locally; no clipboard -> "${copyMsg}"`);

    // A «Respuesta» still waiting when «Terminar» and «Nueva reunión» run must not paint
    // into the next meeting: the stand-in is slowed so the request outlives both taps.
    await mock.setChatDelay(1500);
    await tap(chrome, session, '.meeting .reply-btn');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-reply .reply-status')?.textContent === 'Pensando…'"), { label: '«Pensando…» before the new meeting' });
    await tap(chrome, session, '.meeting .report-btn');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.report .report-status')?.textContent === 'Preparando el informe…'"), { label: '«Preparando el informe…» before the new meeting' });
    await tap(chrome, session, '.meeting .new-meeting');
    await waitFor(() => chrome.evaluate(session, "document.querySelector('.coach-reply').hidden && !document.querySelector('.meeting .reply-btn').disabled"), { label: 'the panel reset by «Nueva reunión»' });
    await sleep(2000);
    const leaked = await chrome.evaluate(session, "!document.querySelector('.coach-reply').hidden || document.querySelector('.coach-reply').textContent !== '' || !document.querySelector('.report').hidden || document.querySelector('.report-body').textContent !== ''");
    await mock.setChatDelay(null);
    if (leaked) throw new Error('[smoke] a reply from the previous meeting painted into the next one');
    console.log('coach: a «Respuesta» and a report in flight when «Nueva reunión» ran was dropped; nothing painted into the new meeting');
    await waitFor(
      () => chrome.evaluate(session, "document.querySelector('.meeting .talk-toggle')?.disabled === false"),
      { timeoutMs: 60000, label: 'the new meeting to record' },
    );
    const streamsBeforeRelease = await chrome.evaluate(session, 'window.__streams.length');
    await chrome.evaluate(session, 'window.__releaseGum()');
    await waitFor(() => chrome.evaluate(session, 'window.__streams.length').then((n) => n > streamsBeforeRelease), { label: 'the held microphone request to settle' });
    await sleep(1500);
    const late = await chrome.evaluate(session, `({
      lateLive: window.__streams.filter((s) => s.__late && s.getTracks().some((t) => t.readyState !== 'ended')).length,
      liveStreams: window.__streams.filter((s) => s.getTracks().some((t) => t.readyState !== 'ended')).length,
    })`);
    if (late.lateLive !== 0 || late.liveStreams !== 1) {
      throw new Error(`[smoke] a stale «Reanudar» reached the new meeting: ${JSON.stringify(late)}`);
    }
    console.log('meeting: a «Reanudar» still waiting for the microphone when «Terminar» and «Nueva reunión» ran was ended on arrival; one capture live');

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
