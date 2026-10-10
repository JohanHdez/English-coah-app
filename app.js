// Routes between screens by what is in storage: no consent → consent, no usable
// transcription provider (a key, or a local server and model) → settings, no print (or one left by a retired embedding model) → enrollment,
// else the meeting. Outside a meeting the header's settings button replaces the
// current screen and always re-routes on the way back, since those three checks
// are themselves the whole navigation history. During a meeting it instead opens
// settings as an overlay on top of #overlay — the meeting in #app is never torn
// down for a setting, only for the two print-dependent actions that end it first.

import * as store from './store.js';
import { MODEL_ID } from './embed.js';
import { isConfigured } from './providers.js';
import { renderConsent } from './ui/consent.js';
import { renderSettings } from './ui/settings.js';
import { renderEnroll } from './ui/enroll.js';
import { renderMeeting } from './ui/meeting.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// Only the loopback harness (Task 7, e2e/) reads this; nothing else is exposed on
// window. Every event the meeting emits is pushed here (createSession's, and the
// live line's `live` / `live-mode`), so the harness can measure bubble latency
// and the live line without instrumenting the DOM; every embedding's round trip
// lands in `embeds`, every live preview pass's in `previews`. The entry is copied
// because the session keeps mutating it as later pieces fold in.
if (location.hostname === '127.0.0.1') {
  window.__ec = { events: [], embeds: [], previews: [] };
}
function reportEvent(event) {
  window.__ec?.events.push({ ...event, entry: event.entry && { ...event.entry }, t: Date.now() });
}

const loadSettings = () => store.loadSettings();

const app = document.getElementById('app');
const header = document.getElementById('header');
const settingsBtn = document.getElementById('settingsBtn');
const overlay = document.getElementById('overlay');

let teardown = null;
// Set only while renderMeeting's screen is the one mounted in #app, so the
// settings button knows to overlay instead of replace, and so the overlay's own
// "Volver" has a live settings object (meeting.js reads it on every provider call,
// so a change here needs no restart) and a way to end the meeting first.
let activeMeeting = null;
let overlayTeardown = null;

function closeOverlay() {
  if (overlayTeardown) {
    try { overlayTeardown(); } catch { /* the overlay's own cleanup failed; proceed anyway */ }
    overlayTeardown = null;
  }
  overlay.hidden = true;
  overlay.textContent = '';
}

function mount(renderFn, ctx) {
  closeOverlay();
  if (teardown) {
    try { teardown(); } catch { /* the outgoing screen's own cleanup failed; proceed anyway */ }
    teardown = null;
  }
  activeMeeting = null;
  const result = renderFn(app, ctx);
  if (typeof result === 'function') teardown = result;
}

// Ends the running meeting (its own cleanup: capture, the embed worker, Wake
// Lock, live recognition) without routing anywhere — the caller decides what
// comes next, since this is also used mid-overlay before a print-dependent
// settings action.
function endActiveMeeting() {
  closeOverlay();
  if (teardown) {
    try { teardown(); } catch { /* the meeting's own cleanup failed; proceed anyway */ }
    teardown = null;
  }
  activeMeeting = null;
}

function openSettingsOverlay() {
  overlay.hidden = false;
  const result = renderSettings(overlay, {
    settings: activeMeeting.settings,
    forced: false,
    onBack: closeOverlay,
    // settings.js calls endMeeting() itself before either print-dependent
    // action, so by the time onReenroll() runs the meeting is already gone
    // and route() alone decides what comes next (enrollment, print or not).
    onReenroll: route,
    endMeeting: endActiveMeeting,
    meetingLive: activeMeeting.live,
    forgetMeeting: activeMeeting.forget,
    onMeetingChange: activeMeeting.onChange,
  });
  if (typeof result === 'function') overlayTeardown = result;
}

async function route() {
  const consent = await store.get('consent');
  header.hidden = !consent;
  const settings = await loadSettings();
  if (!consent) { mount(renderConsent, { settings, onDone: route }); return; }

  if (!isConfigured(settings)) { mount(renderSettings, { settings, forced: true, onBack: route, onReenroll: route }); return; }

  const print = await store.get('print');
  if (!print || print.model !== MODEL_ID) { mount(renderEnroll, { onDone: route }); return; }

  mount(renderMeeting, { settings, onEvent: reportEvent });
  activeMeeting = { settings, live: teardown.live, forget: teardown.forget, onChange: teardown.onChange };
}

settingsBtn.addEventListener('click', async () => {
  if (activeMeeting) { openSettingsOverlay(); return; }
  mount(renderSettings, { settings: await loadSettings(), forced: false, onBack: route, onReenroll: route });
});

app.textContent = 'Cargando…';
route().catch((e) => { app.textContent = e?.message || String(e); });
