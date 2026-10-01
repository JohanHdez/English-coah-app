// First-run privacy notice. Shown once: app.js routes here only while
// store.get('consent') is falsy, and accepting is the only way out.

import * as store from '../store.js';

const PARAGRAPHS = [
  'Esta app escucha a través del micrófono de este dispositivo mientras dura la reunión.',
  'Si usas Groq, el audio de la reunión se envía a Groq para transcribirse.',
  'Tu huella de voz se queda en este dispositivo: nunca se envía a ningún servidor.',
  'Grabar o transcribir una reunión puede requerir el consentimiento de las demás personas y puede estar prohibido por tu empresa — decides tú.',
];

export function renderConsent(root, { onDone }) {
  root.textContent = '';

  const section = document.createElement('section');
  section.className = 'screen consent';

  const h1 = document.createElement('h1');
  h1.textContent = 'Antes de empezar';
  section.append(h1);

  for (const text of PARAGRAPHS) {
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
