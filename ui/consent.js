// First-run privacy notice. Shown once: app.js routes here only while
// store.get('consent') is falsy, and accepting is the only way out. Who receives
// the audio and who the text is read from the current settings (Groq for both
// on a first run); settings.js shows the same lines as the choice changes.

import * as store from '../store.js';
import { routing, migrateSettings } from '../providers.js';

function paragraphs(settings) {
  const { audio, text } = routing(settings);
  return [
    'Esta app escucha a través del micrófono de este dispositivo mientras dura la reunión.',
    audio,
    text,
    'Puedes elegir otro proveedor para cada tarea en Ajustes, con tu propia clave; allí verás siempre quién recibe el audio y quién el texto.',
    'Tu huella de voz se queda en este dispositivo: nunca se envía a ningún servidor.',
    'Grabar o transcribir una reunión puede requerir el consentimiento de las demás personas y puede estar prohibido por tu empresa — decides tú.',
  ];
}

export function renderConsent(root, { settings, onDone }) {
  root.textContent = '';

  const section = document.createElement('section');
  section.className = 'screen consent';

  const h1 = document.createElement('h1');
  h1.textContent = 'Antes de empezar';
  section.append(h1);

  for (const text of paragraphs(migrateSettings(settings))) {
    const p = document.createElement('p');
    p.textContent = text;
    section.append(p);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.textContent = 'Entendido';
  button.addEventListener('click', async () => {
    button.disabled = true;
    await store.set('consent', true);
    onDone();
  });
  section.append(button);

  root.append(section);
}
