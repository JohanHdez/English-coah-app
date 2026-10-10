// What «Mis documentos» keeps of a file: its name, size and the passages of its
// text. Never the bytes.

import { splitPassages } from './lib/passages.js';
import { LIMITS, DocumentError, kindOf } from './docs-extract.js';

// What leaves the device, shown on the consent screen and in «Mis documentos» alike:
// it must say what documentsBlock (lib/coach.js) sends — whole when short, never only
// "related" passages — because Phase 2 learners never see the consent screen again.
export const DOCUMENTS_SENT = 'Cada vez que pulsas «Respuesta» se envían, sólo al proveedor de chat que elegiste, hasta 3000 caracteres de tus documentos activos: el documento entero si es corto, o los fragmentos más relacionados con la pregunta. Desactiva un documento para no enviarlo.';

export function makeRecord(file, { text }, { id, now = Date.now() } = {}) {
  const passages = splitPassages(text).map((p, i) => ({ id: `p${i + 1}`, text: p }));
  if (!passages.length) throw new DocumentError('El documento no tiene texto que leer.');
  return {
    id,
    name: String(file.name || 'documento'),
    type: kindOf(file) || 'text',
    size: file.size,
    chars: text.length,
    addedAt: now,
    enabled: true,
    passages,
  };
}

export function checkRoom(count) {
  if (count >= LIMITS.files) throw new DocumentError(`Ya tienes ${LIMITS.files} documentos: borra uno para añadir otro.`);
}
