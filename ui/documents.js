// «Mis documentos»: the learner's CV and other files, read on the device and kept as
// passages of text (never the file). A file name is untrusted text — textContent only.

import * as store from '../store.js';
import { extractText, LIMITS, DocumentError } from '../docs-extract.js';
import { makeRecord, checkRoom, DOCUMENTS_SENT } from '../docs-record.js';

const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');
const fmtSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function documentsSection() {
  const box = document.createElement('fieldset');
  box.className = 'field documents';
  const legend = document.createElement('legend');
  legend.textContent = 'Mis documentos';
  box.append(legend);

  const privacy = document.createElement('p');
  privacy.className = 'hint';
  privacy.textContent = `El archivo no sale de tu dispositivo. ${DOCUMENTS_SENT}`;

  const list = document.createElement('ul');
  list.className = 'doc-list';

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.docx,.txt,.md';
  input.hidden = true;
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = 'Añadir documento';
  add.addEventListener('click', () => input.click());

  const status = document.createElement('p');
  status.className = 'hint doc-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  const say = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
    status.hidden = !text;
  };

  async function refresh() {
    const docs = await store.listDocuments();
    list.textContent = '';
    for (const doc of docs) list.append(row(doc));
    add.disabled = docs.length >= LIMITS.files;
    if (add.disabled && status.hidden) say(`Ya tienes ${LIMITS.files} documentos: borra uno para añadir otro.`);
  }

  function row(doc) {
    const li = document.createElement('li');
    li.className = 'doc';
    const name = document.createElement('strong');
    name.textContent = doc.name;
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent = `${fmtSize(doc.size)} · ${fmtNum(doc.chars)} caracteres`;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = doc.enabled;
    toggle.addEventListener('change', () => store.setDocumentEnabled(doc.id, toggle.checked).catch((e) => say(`[documentos] ${e?.message || e}`, true)));
    toggle.setAttribute('aria-label', `Usar ${doc.name} en las reuniones`);
    const use = document.createElement('label');
    use.className = 'checkbox';
    use.append(toggle, document.createTextNode('Usar en las reuniones'));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'doc-delete';
    del.textContent = 'Borrar';
    del.setAttribute('aria-label', `Borrar ${doc.name}`);
    del.addEventListener('click', async () => {
      if (!confirm(`¿Borrar «${doc.name}» de este dispositivo?`)) return;
      try {
        await store.deleteDocument(doc.id);
        say('');
      } catch {
        say('[documentos] No se pudo borrar el documento.', true);
      }
      await refresh().catch(() => {});
    });
    li.append(name, meta, use, del);
    return li;
  }

  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    add.disabled = true;
    say('Leyendo…');
    try {
      checkRoom((await store.listDocuments()).length);
      const extracted = await extractText(file, {
        onPage: (n, of) => say(`Leyendo… ${n} de ${of} páginas`),
      });
      await store.putDocument(makeRecord(file, extracted, { id: crypto.randomUUID() }));
      say('');
    } catch (e) {
      say(e instanceof DocumentError ? e.message
        : e?.name === 'QuotaExceededError' ? '[documentos] No queda espacio en este dispositivo.'
          : '[documentos] No se pudo guardar el documento.', true);
    }
    await refresh().catch(() => {});
  });

  box.append(privacy, list, add, input, status);
  refresh().catch((e) => say(`[documentos] ${e?.message || e}`, true));
  return box;
}
