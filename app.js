// Routes between screens by what is in storage: no consent → consent, no Groq key
// → settings, no print (or one left by a retired embedding model) → enrollment,
// else the meeting. The header's settings button is the only way back to settings
// once past it and always re-routes afterwards instead of remembering where it
// came from, since those three checks are themselves the whole navigation history.

import * as store from './store.js';
import { MODEL_ID } from './embed.js';
import { renderConsent } from './ui/consent.js';
import { renderSettings } from './ui/settings.js';
import { renderEnroll } from './ui/enroll.js';
import { renderMeeting } from './ui/meeting.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// Only the loopback harness (Task 7, e2e/) reads this; nothing else is exposed on
// window. Every event createSession emits during a meeting is pushed here, so the
// harness can measure bubble latency without instrumenting the DOM.
if (location.hostname === '127.0.0.1') {
  window.__ec = { events: [] };
}
function reportEvent(event) {
  window.__ec?.events.push({ ...event, t: Date.now() });
}

const DEFAULT_SETTINGS = { groqKey: '', lang: 'en', translate: true };

async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(await store.get('settings')) };
}

const app = document.getElementById('app');
const header = document.getElementById('header');
const settingsBtn = document.getElementById('settingsBtn');

let teardown = null;
function mount(renderFn, ctx) {
  if (teardown) {
    try { teardown(); } catch { /* the outgoing screen's own cleanup failed; proceed anyway */ }
    teardown = null;
  }
  const result = renderFn(app, ctx);
  if (typeof result === 'function') teardown = result;
}

async function route() {
  const consent = await store.get('consent');
  header.hidden = !consent;
  if (!consent) { mount(renderConsent, { onDone: route }); return; }

  const settings = await loadSettings();
  if (!settings.groqKey) { mount(renderSettings, { settings, forced: true, onDone: route }); return; }

  const print = await store.get('print');
  if (!print || print.model !== MODEL_ID) { mount(renderEnroll, { onDone: route }); return; }

  mount(renderMeeting, { settings, onEvent: reportEvent });
}

settingsBtn.addEventListener('click', async () => {
  mount(renderSettings, { settings: await loadSettings(), forced: false, onDone: route });
});

app.textContent = 'Cargando…';
route();
