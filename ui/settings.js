// Groq key, meeting language, translation toggle, and the three destructive
// actions. Reached either as the forced step between consent and enrollment (no
// Groq key yet — app.js routes here), from the header's settings button between
// meetings, or — endMeeting present — as an overlay on top of a running meeting,
// which is why every field saves itself as it changes rather than waiting on a
// single submit: `settings` is the very object the live session reads from, so a
// key, language or translation change here reaches its next Groq call with no
// restart. The print a running meeting's speaker state depends on cannot change
// out from under it, so when endMeeting is given, re-enrolling or deleting the
// print ends the meeting first (confirmed) before either touches the print.

import * as store from '../store.js';

function field(labelText, input) {
  const label = document.createElement('label');
  label.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  label.append(span, input);
  return label;
}

export function renderSettings(root, { settings, forced, onBack, onReenroll, endMeeting }) {
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

  // --- Groq key ---------------------------------------------------------
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.placeholder = 'Pega tu API key de Groq';
  keyInput.value = settings.groqKey || '';
  section.append(field('Clave de Groq', keyInput));

  const link = document.createElement('a');
  link.href = 'https://console.groq.com';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Consíguela gratis en console.groq.com';
  section.append(link);

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
  translateInput.addEventListener('change', () => patch({ translate: translateInput.checked }));
  const translateLabel = document.createElement('label');
  translateLabel.className = 'checkbox';
  translateLabel.append(translateInput, document.createTextNode('Traducir al español'));
  section.append(translateLabel);

  keyInput.addEventListener('input', () => {
    patch({ groqKey: keyInput.value.trim() });
    if (continueBtn) continueBtn.disabled = !keyInput.value.trim();
  });

  // --- Navigation ---------------------------------------------------------
  let continueBtn = null;
  if (forced) {
    continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'primary';
    continueBtn.textContent = 'Continuar';
    continueBtn.disabled = !keyInput.value.trim();
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
  if (endMeeting) {
    // The running meeting re-persists [...restored, ...session.transcript()]
    // after every bubble, so a delete here would be silently undone within
    // seconds by the very next one — disabled instead of pretending it worked.
    deleteTranscript.disabled = true;
    const hint = document.createElement('p');
    hint.className = 'notice';
    hint.textContent = 'Termina la reunión para borrarla.';
    danger.append(hint);
  } else {
    deleteTranscript.addEventListener('click', async () => {
      if (!confirm('¿Borrar la última conversación guardada en este dispositivo?')) return;
      await store.del('lastTranscript');
      setNotice('Conversación borrada.');
    });
  }

  section.append(danger);

  const notice = document.createElement('p');
  notice.className = 'notice';
  notice.hidden = true;
  section.append(notice);
  function setNotice(text) {
    notice.textContent = text;
    notice.hidden = false;
  }

  root.append(section);
}
