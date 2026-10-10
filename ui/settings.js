// Which AI transcribes and which translates and coaches, each provider's key and
// models, meeting language, translation toggle, and the three destructive
// actions. Reached either as the forced step between consent and enrollment (no
// usable transcription provider yet — app.js routes here), from the header's
// settings button between meetings, or — endMeeting present — as an overlay on top of a running meeting,
// which is why every field saves itself as it changes rather than waiting on a
// single submit: `settings` is the very object the live session reads from, so a
// provider, key, language or translation change here reaches its next call with
// no restart. The print a running meeting's speaker state depends on cannot change
// out from under it, so when endMeeting is given, re-enrolling or deleting the
// print ends the meeting first (confirmed) before either touches the print.

import * as store from '../store.js';
import { profileFields } from './coach.js';
import { CATALOGUE } from '../lib/phrasebook.js';
import { categoryActive, setCategoryActive } from '../coachdata.js';
import { providersFor, providerById, routing, isConfigured, isChatConfigured, isLocalBase } from '../providers.js';
import { isMobile, deviceFacts, previewEnabled } from '../live-lane.js';

function field(labelText, input) {
  const label = document.createElement('label');
  label.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  label.append(span, input);
  return label;
}

export function renderSettings(root, { settings, forced, onBack, onReenroll, endMeeting, meetingLive, forgetMeeting, onMeetingChange }) {
  root.textContent = '';

  const section = document.createElement('section');
  section.className = 'screen settings';

  const h1 = document.createElement('h1');
  h1.textContent = 'Ajustes';
  section.append(h1);

  async function patch(fields) {
    Object.assign(settings, fields);
    await store.set('settings', settings);
  }

  // --- Who does what ---------------------------------------------------------
  const route = document.createElement('div');
  route.className = 'routing';
  const audioLine = document.createElement('p');
  const textLine = document.createElement('p');
  // Someone who pastes only a transcription key otherwise gets a meeting with no
  // coach and, without the browser's Translator, no Spanish, and nothing saying why.
  const chatWarning = document.createElement('p');
  chatWarning.className = 'hint error';
  chatWarning.hidden = true;
  route.append(audioLine, textLine, chatWarning);

  function picker(legendText, job, key) {
    const select = document.createElement('select');
    for (const p of providersFor(job)) {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.label;
      select.append(option);
    }
    select.value = settings[key];
    select.addEventListener('change', () => { patch({ [key]: select.value }); refresh(); });
    return field(legendText, select);
  }

  section.append(picker('Transcripción', 'transcribe', 'transcribeProvider'));
  const claudeNote = document.createElement('p');
  claudeNote.className = 'hint';
  claudeNote.textContent = 'Claude no recibe audio: úsalo para la traducción y el coach.';
  section.append(claudeNote);
  section.append(picker('Traducción y coach', 'chat', 'chatProvider'));
  section.append(route);

  // One block per chosen provider: its key, and a model field for each job it does.
  const details = document.createElement('div');
  details.className = 'providers';
  section.append(details);

  function patchNested(name, id, value) {
    patch({ [name]: { ...settings[name], [id]: value } });
  }

  function providerBlock(p, jobs) {
    const block = document.createElement('fieldset');
    block.className = 'field provider';
    const legend = document.createElement('legend');
    legend.textContent = p.label;
    block.append(legend);

    if (p.id === 'local') {
      const baseInput = document.createElement('input');
      baseInput.type = 'url';
      baseInput.autocomplete = 'off';
      baseInput.placeholder = 'http://localhost:8000';
      baseInput.value = settings.localBase || '';
      const warn = document.createElement('p');
      warn.className = 'hint';
      warn.textContent = 'Solo se aceptan direcciones http://localhost o http://127.0.0.1: el audio no sale de este dispositivo.';
      baseInput.addEventListener('input', () => {
        const value = baseInput.value.trim();
        warn.classList.toggle('error', value !== '' && !isLocalBase(value));
        patch({ localBase: value });
        updateContinue();
      });
      block.append(field('Dirección del servidor (compatible con OpenAI)', baseInput), warn);
    }

    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.placeholder = p.id === 'local' ? 'Opcional' : `Pega tu API key de ${p.label}`;
    keyInput.value = settings.keys?.[p.id] || '';
    keyInput.addEventListener('input', () => { patchNested('keys', p.id, keyInput.value.trim()); updateContinue(); });
    block.append(field(p.id === 'local' ? 'Clave (opcional)' : `Clave de ${p.label}`, keyInput));

    if (p.keyUrl) {
      const link = document.createElement('a');
      link.href = p.keyUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = `Consíguela en ${new URL(p.keyUrl).hostname}`;
      block.append(link);
    }

    for (const job of jobs) {
      const modelInput = document.createElement('input');
      modelInput.type = 'text';
      modelInput.autocomplete = 'off';
      modelInput.spellcheck = false;
      modelInput.placeholder = p.models[job] || (job === 'transcribe' ? 'p. ej. whisper-1' : 'p. ej. llama3.2');
      modelInput.value = settings.models?.[p.id]?.[job] || '';
      modelInput.addEventListener('input', () => {
        patchNested('models', p.id, { ...settings.models?.[p.id], [job]: modelInput.value.trim() });
        updateContinue();
      });
      block.append(field(job === 'transcribe' ? 'Modelo de transcripción' : 'Modelo de traducción y coach', modelInput));
    }
    return block;
  }

  function refreshRouting() {
    const { audio, text } = routing(settings);
    audioLine.textContent = audio;
    textLine.textContent = text;
    const label = providerById(settings.chatProvider)?.label || settings.chatProvider;
    chatWarning.textContent = settings.chatProvider === 'local'
      ? 'Falta configurar el servidor local de traducción y coach: no habrá coach, y solo habrá traducción si el navegador traduce por sí mismo.'
      : `Falta la API key de ${label}: no habrá coach, y solo habrá traducción si el navegador traduce por sí mismo.`;
    chatWarning.hidden = isChatConfigured(settings);
  }

  function refresh() {
    refreshRouting();
    details.textContent = '';
    const chosen = new Map();
    chosen.set(settings.transcribeProvider, ['transcribe']);
    chosen.set(settings.chatProvider, [...(chosen.get(settings.chatProvider) || []), 'chat']);
    for (const [id, jobs] of chosen) details.append(providerBlock(providerById(id), jobs));
    updateContinue();
  }

  // --- Meeting language ---------------------------------------------------
  const langFieldset = document.createElement('fieldset');
  langFieldset.className = 'field';
  const langLegend = document.createElement('legend');
  langLegend.textContent = 'Idioma de la reunión';
  langFieldset.append(langLegend);
  for (const [value, text] of [['en', 'Inglés'], ['multi', 'Reunión bilingüe — inglés y español']]) {
    const label = document.createElement('label');
    label.className = 'radio';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'lang';
    input.value = value;
    input.checked = (settings.lang || 'en') === value;
    input.addEventListener('change', () => { if (input.checked) patch({ lang: value }); });
    const span = document.createElement('span');
    span.textContent = text;
    label.append(input, span);
    langFieldset.append(label);
  }
  section.append(langFieldset);

  // --- Translation ---------------------------------------------------------
  const translateInput = document.createElement('input');
  translateInput.type = 'checkbox';
  translateInput.checked = settings.translate !== false;
  translateInput.addEventListener('change', () => { patch({ translate: translateInput.checked }); refreshRouting(); });
  const translateLabel = document.createElement('label');
  translateLabel.className = 'checkbox';
  translateLabel.append(translateInput, document.createTextNode('Traducir al español'));
  section.append(translateLabel);

  const previewInput = document.createElement('input');
  previewInput.type = 'checkbox';
  previewInput.checked = previewEnabled(settings.livePreview, isMobile(deviceFacts(globalThis)));
  previewInput.addEventListener('change', () => patch({ livePreview: previewInput.checked }));
  const previewLabel = document.createElement('label');
  previewLabel.className = 'checkbox';
  previewLabel.append(previewInput, document.createTextNode('Texto en vivo con Whisper local (descarga ~120 MB la primera vez)'));
  section.append(previewLabel);

  // --- Coach: profile, today's context, phrases ---------------------------------
  section.append(profileFields(settings, (text) => setNotice(text)));

  const phrasesFieldset = document.createElement('fieldset');
  phrasesFieldset.className = 'field';
  const phrasesLegend = document.createElement('legend');
  phrasesLegend.textContent = 'Frases rápidas en la reunión';
  phrasesFieldset.append(phrasesLegend);
  for (const { cat } of CATALOGUE) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = categoryActive(settings, cat);
    input.addEventListener('change', () => patch(setCategoryActive(settings, cat, input.checked)));
    const label = document.createElement('label');
    label.className = 'checkbox';
    label.append(input, document.createTextNode(cat));
    phrasesFieldset.append(label);
  }
  section.append(phrasesFieldset);

  // --- Navigation ---------------------------------------------------------
  let continueBtn = null;
  if (forced) {
    continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'primary';
    continueBtn.textContent = 'Continuar';
    continueBtn.addEventListener('click', () => onBack());
    section.append(continueBtn);
  } else {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'primary';
    backBtn.textContent = 'Volver';
    backBtn.addEventListener('click', () => onBack());
    section.append(backBtn);
  }

  // --- Destructive actions ---------------------------------------------------------
  const danger = document.createElement('div');
  danger.className = 'danger-zone';

  const reenroll = document.createElement('button');
  reenroll.type = 'button';
  reenroll.textContent = 'Volver a registrar mi voz';
  reenroll.addEventListener('click', async () => {
    const msg = endMeeting
      ? '¿Terminar la reunión en curso y registrar tu voz de nuevo? La huella actual se borrará.'
      : '¿Borrar tu huella de voz y registrarla de nuevo ahora?';
    if (!confirm(msg)) return;
    if (endMeeting) await endMeeting();
    await store.del('print');
    onReenroll();
  });
  danger.append(reenroll);

  const deletePrint = document.createElement('button');
  deletePrint.type = 'button';
  deletePrint.textContent = 'Borrar mi huella de voz';
  deletePrint.addEventListener('click', async () => {
    if (endMeeting) {
      if (!confirm('¿Terminar la reunión en curso y borrar tu huella de voz?')) return;
      await endMeeting();
      await store.del('print');
      onReenroll(); // no print left: the next screen is enrollment either way
      return;
    }
    if (!confirm('¿Borrar tu huella de voz? Tendrás que registrarla de nuevo para la próxima reunión.')) return;
    await store.del('print');
    setNotice('Huella de voz borrada.');
  });
  danger.append(deletePrint);

  const deleteTranscript = document.createElement('button');
  deleteTranscript.type = 'button';
  deleteTranscript.textContent = 'Borrar la conversación guardada';
  danger.append(deleteTranscript);
  // A running meeting re-persists [...restored, ...session.transcript()] after
  // every bubble, so a delete then would be silently undone within seconds by the
  // very next one — disabled instead of pretending it worked. Between meetings the
  // screen underneath is emptied too, so nothing on it writes the record back.
  const deleteHint = document.createElement('p');
  deleteHint.className = 'notice';
  deleteHint.textContent = 'Termina la reunión para borrarla.';
  danger.append(deleteHint);
  function syncDeleteTranscript() {
    const live = !!meetingLive?.();
    deleteTranscript.disabled = live;
    deleteHint.hidden = !live;
  }
  syncDeleteTranscript();
  deleteTranscript.addEventListener('click', async () => {
    if (meetingLive?.()) return;
    if (!confirm('¿Borrar la última conversación guardada en este dispositivo?')) return;
    if (forgetMeeting) {
      if (!await forgetMeeting()) { setNotice('Termina la reunión para borrarla.'); return; }
    } else {
      await store.del('lastTranscript');
    }
    setNotice('Conversación borrada.');
  });
  const unsubscribe = onMeetingChange?.(syncDeleteTranscript);

  section.append(danger);

  function updateContinue() {
    if (continueBtn) continueBtn.disabled = !isConfigured(settings);
    refreshRouting();
  }
  refresh();

  const notice = document.createElement('p');
  notice.className = 'notice';
  notice.hidden = true;
  section.append(notice);
  function setNotice(text) {
    notice.textContent = text;
    notice.hidden = false;
  }

  root.append(section);
  return () => unsubscribe?.();
}
