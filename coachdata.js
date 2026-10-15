// The pure half of the coach panel: what the suggested answer's markup means, and the
// settings writes behind custom phrases, deleted notes and the phrase categories.
// Every function takes a settings object and returns a new one; the panel decides
// when to persist it. The ones phrasebook.js already owns (addNote, toggleNoteOpen)
// are not repeated here.

import { CATALOGUE, DEFAULT_PHRASE_IDS, MAX_CUSTOM } from './lib/phrasebook.js';

export const CUSTOM_PHRASE_MAX = 200;

const clamp = (value, max) => String(value ?? '').trim().slice(0, max);

// The model wraps the answer's key term in double asterisks. An unpaired marker
// leaves the tail plain rather than bold: a truncated answer must not turn bold
// halfway through.
export function richParts(text) {
  const pieces = String(text ?? '').split('**');
  const closed = pieces.length % 2 === 1;
  return pieces
    .map((part, i) => ({ text: part, bold: i % 2 === 1 && (closed || i < pieces.length - 1) }))
    .filter((p) => p.text);
}

export const plainReply = (text) => String(text ?? '').replace(/\*\*/g, '');

export function addCustomPhrase(settings = {}, { en, es } = {}, now = Date.now()) {
  const list = Array.isArray(settings.customPhrases) ? settings.customPhrases : [];
  const phrase = clamp(en, CUSTOM_PHRASE_MAX);
  if (!phrase || list.length >= MAX_CUSTOM) return settings;
  const item = { id: `c.${now}.${list.length}`, en: phrase, es: clamp(es, CUSTOM_PHRASE_MAX) };
  return { ...settings, customPhrases: [...list, item] };
}

export function removeCustomPhrase(settings = {}, id) {
  const list = Array.isArray(settings.customPhrases) ? settings.customPhrases : [];
  return { ...settings, customPhrases: list.filter((p) => p && p.id !== id) };
}

export function deleteNote(settings = {}, id) {
  const notes = Array.isArray(settings.notes) ? settings.notes : [];
  return { ...settings, notes: notes.filter((n) => n && n.id !== id) };
}

const idsOf = (cat) => (CATALOGUE.find((c) => c.cat === cat)?.items || []).map((i) => i.id);
const activeIds = (settings) => (Array.isArray(settings.phraseIds) ? settings.phraseIds : DEFAULT_PHRASE_IDS);

export function categoryActive(settings = {}, cat) {
  const ids = idsOf(cat);
  const active = new Set(activeIds(settings));
  return ids.length > 0 && ids.every((id) => active.has(id));
}

// Switches a whole catalogue category on or off. The first write turns the
// implicit default selection into an explicit one, so switching one category
// never silently drops the others.
export function setCategoryActive(settings = {}, cat, on) {
  const ids = new Set(idsOf(cat));
  const rest = activeIds(settings).filter((id) => !ids.has(id));
  return { ...settings, phraseIds: on ? [...rest, ...ids] : rest };
}

// The conversation the coach reads: turns restored from an unfinished meeting
// first, then this session's own. Empty text is dropped so a blank bubble never
// stands for "the last question".
export function replyTurns(restored = [], live = []) {
  return [...restored, ...live].filter((t) => t && String(t.text ?? '').trim());
}

export function clampField(value, max) {
  return String(value ?? '').slice(0, max);
}

const SAVE_WHAT = { note: 'la nota', phrase: 'la frase', profile: 'tu perfil', context: 'el contexto' };

// A failed storage write keeps the change in memory, so the meeting still uses it;
// the learner is told it will not survive a reload.
export function saveFailureText(kind) {
  return `[almacenamiento] No se pudo guardar ${SAVE_WHAT[kind] || 'el cambio'}.`;
}

// The conversation as Markdown for «Descargar conversación»: one block per bubble with
// its clock time, who spoke, the English and, when there is one, its Spanish. `t` is
// the bubble's capture time (Date.now() milliseconds).
export function transcriptMarkdown(entries = [], when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (t) => {
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '';
  };
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const lines = [`# Conversación — ${day}`, ''];
  for (const e of entries) {
    const text = String(e?.text ?? '').trim();
    if (!text) continue;
    const who = e.speaker === 'me' ? 'Yo' : 'Interlocutor';
    const time = clock(e.t);
    lines.push(`**${time ? `[${time}] ` : ''}${who}:** ${text}`);
    const es = String(e.es ?? '').trim();
    if (es) lines.push(`> ${es}`);
    lines.push('');
  }
  return lines.join('\n');
}
