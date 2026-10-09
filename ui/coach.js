// The coaching panel above the conversation: «Frases», «Notas» and «Contexto» as
// tabs capped at half the screen, and the suggested answer, which takes that same
// panel instead of opening a third strip so the conversation never moves. It holds
// no state a meeting depends on: phrases, notes, profile and context live in
// `settings` (the object the settings overlay edits too), so every tab is rebuilt
// from it each time it opens, and the next «Respuesta» reads the latest values.

import * as store from '../store.js';
import { askReply, PROFILE_MAX_CHARS, CONTEXT_MAX_CHARS } from '../lib/coach.js';
import {
  resolvePhrases, phraseCategories, resolveNotes, addNote, toggleNoteOpen,
  NOTE_TITLE_MAX, NOTE_BODY_MAX, MAX_NOTES, MAX_CUSTOM, CUSTOM_CAT,
} from '../lib/phrasebook.js';
import {
  richParts, plainReply, addCustomPhrase, removeCustomPhrase, deleteNote,
  replyTurns, clampField, saveFailureText, CUSTOM_PHRASE_MAX,
} from '../coachdata.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

async function save(settings) {
  await store.set('settings', settings);
}

// A textarea with a live character counter that writes the setting as the learner
// types: the profile and the context are used by the very next «Respuesta».
export function limitedField({ label, hint, max, value, read, onInput, rows = 4 }) {
  const wrap = el('label', 'field');
  wrap.append(el('span', '', label));
  const area = el('textarea');
  area.rows = rows;
  area.maxLength = max;
  area.value = clampField(value, max);
  area.spellcheck = false;
  const count = el('span', 'hint counter');
  const refresh = () => { count.textContent = `${area.value.length} / ${max}`; };
  area.addEventListener('input', () => { refresh(); onInput(area.value); });
  // Ajustes may have edited the same setting while this field sat open.
  area.addEventListener('focus', () => {
    const current = clampField(read(), max);
    if (current !== area.value) { area.value = current; refresh(); }
  });
  refresh();
  wrap.append(area);
  if (hint) wrap.append(el('span', 'hint', hint));
  wrap.append(count);
  return wrap;
}

export function profileFields(settings, onError = () => {}) {
  const timers = {};
  const write = (key, kind) => (value) => {
    settings[key] = clampField(value, key === 'profile' ? PROFILE_MAX_CHARS : CONTEXT_MAX_CHARS);
    // One put per pause, not per keystroke; the in-memory value is already current.
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => save(settings).catch(() => onError(saveFailureText(kind))), 300);
  };
  const box = el('div', 'profile-fields');
  box.append(
    limitedField({
      label: 'Tu perfil',
      hint: 'Tu experiencia real: el coach solo usa estos datos para hablar de ti.',
      max: PROFILE_MAX_CHARS, value: settings.profile, read: () => settings.profile, onInput: write('profile', 'profile'),
    }),
    limitedField({
      label: 'Contexto de hoy',
      hint: 'De qué va esta reunión: temas, nombres, lo que quieres lograr.',
      max: CONTEXT_MAX_CHARS, value: settings.sessionContext, read: () => settings.sessionContext, onInput: write('sessionContext', 'context'),
    }),
  );
  return box;
}

export function createCoachPanel({ settings, getTurns, onToast, onBusy, onLayout = () => {} }) {
  const root = el('div', 'coach-panel');

  const tabs = el('div', 'coach-tabs');
  tabs.setAttribute('role', 'tablist');
  const body = el('div', 'coach-body');
  body.hidden = true;
  const reply = el('div', 'coach-reply');
  reply.hidden = true;
  root.append(tabs, body, reply);

  const TABS = [['phrases', 'Frases'], ['notes', 'Notas'], ['context', 'Contexto']];
  const tabButtons = new Map();
  let active = null; // null while collapsed
  let category = null;
  let controller = null;
  let epoch = 0;
  let built = false;
  let destroyed = false;

  async function commit(next, kind) {
    Object.assign(settings, next);
    await save(settings).catch(() => onToast(saveFailureText(kind)));
  }

  async function copy(text, node) {
    try {
      await navigator.clipboard.writeText(text);
      node?.classList.add('copied');
      setTimeout(() => node?.classList.remove('copied'), 1200);
      onToast('Copiado');
    } catch {
      onToast('No se pudo copiar');
    }
  }

  // --- Frases ---------------------------------------------------------------
  function phrasesView() {
    const view = el('div', 'phrases');
    const phrases = resolvePhrases(settings);
    const cats = phraseCategories(phrases);
    if (!cats.includes(CUSTOM_CAT)) cats.push(CUSTOM_CAT);
    if (!cats.includes(category)) category = cats[0];

    const row = el('div', 'cat-row');
    for (const cat of cats) {
      const b = button('cat' + (cat === category ? ' on' : ''), cat, () => { category = cat; renderBody(); });
      b.setAttribute('aria-pressed', String(cat === category));
      row.append(b);
    }
    view.append(row);

    const chips = el('div', 'chips');
    for (const phrase of phrases.filter((p) => p.cat === category)) {
      const item = el('div', 'chip-item');
      const chip = button('chip', '', () => copy(phrase.en, chip));
      chip.append(el('b', '', phrase.en));
      if (phrase.es) chip.append(el('i', '', phrase.es));
      item.append(chip);
      if (category === CUSTOM_CAT) {
        const del = button('icon-delete', '×', async () => { await commit(removeCustomPhrase(settings, phrase.id), 'phrase'); renderBody(); });
        del.setAttribute('aria-label', `Borrar la frase ${phrase.en}`);
        item.append(del);
      }
      chips.append(item);
    }
    view.append(chips);

    if (category === CUSTOM_CAT) {
      const custom = (settings.customPhrases || []).length;
      const form = el('form', 'add-form');
      const en = el('input');
      en.type = 'text';
      en.placeholder = 'Tu frase en inglés';
      en.maxLength = CUSTOM_PHRASE_MAX;
      en.autocomplete = 'off';
      en.setAttribute('aria-label', 'Tu frase en inglés');
      const es = el('input');
      es.type = 'text';
      es.placeholder = 'Qué significa (opcional)';
      es.maxLength = CUSTOM_PHRASE_MAX;
      es.autocomplete = 'off';
      es.setAttribute('aria-label', 'Qué significa');
      const add = el('button', 'primary', 'Añadir frase');
      add.type = 'submit';
      add.disabled = custom >= MAX_CUSTOM;
      form.append(en, es, add);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!en.value.trim()) return;
        await commit(addCustomPhrase(settings, { en: en.value, es: es.value }), 'phrase');
        renderBody();
      });
      view.append(form);
      if (custom >= MAX_CUSTOM) view.append(el('p', 'hint', `Máximo ${MAX_CUSTOM} frases propias: borra alguna para añadir otra.`));
    }
    return view;
  }

  // --- Notas ----------------------------------------------------------------
  function notesView() {
    const view = el('div', 'notes');
    const notes = resolveNotes(settings);
    if (!notes.length) view.append(el('p', 'hint', 'Aún no tienes notas. Escribe una abajo: puedes añadirlas en plena reunión.'));
    for (const note of notes) {
      const item = el('div', 'note' + (note.open ? ' open' : ''));
      const head = button('note-head', note.title || note.body.slice(0, NOTE_TITLE_MAX), async () => {
        await commit(toggleNoteOpen(settings, note.id), 'note');
        renderBody();
      });
      head.setAttribute('aria-expanded', String(note.open));
      item.append(head);
      if (note.open) {
        item.append(el('p', 'note-text', note.body || note.title));
        const del = button('note-delete', 'Borrar nota', async () => { await commit(deleteNote(settings, note.id), 'note'); renderBody(); });
        item.append(del);
      }
      view.append(item);
    }

    const form = el('form', 'add-form');
    const title = el('input');
    title.type = 'text';
    title.placeholder = 'Título';
    title.maxLength = NOTE_TITLE_MAX;
    title.autocomplete = 'off';
    title.setAttribute('aria-label', 'Título de la nota');
    const text = el('textarea');
    text.rows = 3;
    text.placeholder = 'Lo que quieres tener a mano';
    text.maxLength = NOTE_BODY_MAX;
    text.setAttribute('aria-label', 'Texto de la nota');
    const add = el('button', 'primary', 'Guardar nota');
    add.type = 'submit';
    add.disabled = (settings.notes || []).length >= MAX_NOTES;
    form.append(title, text, add);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = addNote(settings, { title: title.value, body: text.value });
      if (next === settings) return;
      await commit(next, 'note');
      renderBody();
    });
    view.append(form);
    if (add.disabled) view.append(el('p', 'hint', `Máximo ${MAX_NOTES} notas: borra alguna para añadir otra.`));
    return view;
  }

  // --- Tabs -----------------------------------------------------------------
  function renderBody() {
    if (destroyed) return;
    body.textContent = '';
    body.hidden = active === null;
    for (const [id, button_] of tabButtons) {
      button_.classList.toggle('on', id === active);
      button_.setAttribute('aria-selected', String(id === active));
    }
    refreshCounts();
    if (active === 'phrases') body.append(phrasesView());
    else if (active === 'notes') body.append(notesView());
    else if (active === 'context') body.append(profileFields(settings, onToast));
    if (built) onLayout();
  }

  function refreshCounts() {
    const n = resolveNotes(settings).length;
    tabButtons.get('notes').textContent = n ? `Notas ${n}` : 'Notas';
  }

  for (const [id, label] of TABS) {
    const b = button('coach-tab', label, () => { active = active === id ? null : id; renderBody(); });
    b.setAttribute('role', 'tab');
    b.dataset.tab = id;
    tabButtons.set(id, b);
    tabs.append(b);
  }
  renderBody();
  built = true;

  // --- Respuesta ------------------------------------------------------------
  function group(title, items, rich) {
    const box = el('div', 'reply-group');
    box.append(el('span', 'reply-label', title));
    for (const item of items) {
      const b = button('reply-item' + (rich ? ' answer' : ''), '', () => copy(plainReply(item.en), b));
      const en = el('span', 'reply-en');
      if (rich) {
        for (const part of richParts(item.en)) {
          if (part.bold) en.append(el('b', '', part.text));
          else en.append(document.createTextNode(part.text));
        }
      } else {
        en.textContent = plainReply(item.en);
      }
      b.append(en);
      if (item.es) b.append(el('i', '', item.es));
      box.append(b);
    }
    return box;
  }

  function showReply({ pending = false, error = '', answer = [], ideas = [] }) {
    tabs.hidden = true;
    body.hidden = true;
    reply.hidden = false;
    reply.textContent = '';
    const head = el('div', 'reply-head');
    head.append(el('span', 'reply-title', 'Respuesta sugerida'));
    const close = button('reply-close', '×', closeReply);
    close.setAttribute('aria-label', 'Cerrar la respuesta');
    head.append(close);
    reply.append(head);
    if (pending) {
      const p = el('p', 'reply-status', 'Pensando…');
      p.setAttribute('role', 'status');
      reply.append(p);
    } else if (error) {
      const p = el('p', 'reply-status error', error);
      p.setAttribute('role', 'alert');
      reply.append(p);
    } else {
      if (answer.length) reply.append(group('Di esto', answer, true));
      if (ideas.length) reply.append(group('Para estudiar', ideas, false));
    }
    onLayout();
  }

  function closeReply() {
    if (controller) { controller.abort(); controller = null; onBusy(false); }
    reply.hidden = true;
    reply.textContent = '';
    tabs.hidden = false;
    renderBody();
  }

  async function ask() {
    if (controller) return;
    const turns = replyTurns(getTurns());
    if (!turns.length) {
      showReply({ error: '[coach] Aún no hay conversación a la que responder.' });
      return;
    }
    controller = new AbortController();
    const mine = controller;
    const asked = epoch;
    onBusy(true);
    showReply({ pending: true });
    try {
      const result = await askReply({ turns, settings, signal: mine.signal });
      if (!mine.signal.aborted && !destroyed && asked === epoch) showReply(result);
    } catch (err) {
      if (!mine.signal.aborted && !destroyed && asked === epoch) showReply({ error: err?.message || String(err) });
    } finally {
      if (controller === mine) { controller = null; onBusy(false); }
    }
  }

  return {
    el: root,
    ask,
    reset() {
      epoch++;
      closeReply();
    },
    destroy() { destroyed = true; controller?.abort(); },
  };
}
