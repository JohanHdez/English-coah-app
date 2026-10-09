// The closing report: after «Terminar» the learner asks for a Spanish report on
// their own English. One request at a time; a report that lands after
// «Nueva reunión» (reset) is dropped, like the suggested reply. The markdown is
// rendered by lib/markdown.js (nodes, never innerHTML); «Descargar .md» builds a
// Blob locally.

import { askReport } from '../lib/coach.js';
import { renderMarkdown } from '../lib/markdown.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createReportPanel({ settings, getTurns, onToast, onReport = () => {}, onBusy = () => {} }) {
  const root = el('section', 'report');
  root.hidden = true;
  const head = el('div', 'report-head');
  head.append(el('span', 'report-title', 'Informe de la reunión'));
  const copyBtn = el('button', 'report-copy', 'Copiar');
  copyBtn.type = 'button';
  const downloadBtn = el('button', 'report-download', 'Descargar .md');
  downloadBtn.type = 'button';
  head.append(copyBtn, downloadBtn);
  const status = el('p', 'report-status');
  status.setAttribute('role', 'status');
  const body = el('div', 'report-body');
  root.append(head, status, body);

  let controller = null;
  let epoch = 0;
  let destroyed = false;
  let markdown = '';

  function paint({ text = '', error = '', pending = false }) {
    root.hidden = false;
    status.textContent = pending ? 'Preparando el informe…' : error;
    status.hidden = !status.textContent;
    status.classList.toggle('error', !!error);
    status.setAttribute('role', error ? 'alert' : 'status');
    body.textContent = '';
    if (text) body.append(renderMarkdown(text));
    copyBtn.hidden = downloadBtn.hidden = !text;
  }

  async function generate() {
    if (controller) return;
    controller = new AbortController();
    const mine = controller;
    const asked = epoch;
    markdown = '';
    onBusy(true);
    paint({ pending: true });
    try {
      const text = await askReport({ turns: getTurns(), settings, signal: mine.signal });
      if (!mine.signal.aborted && !destroyed && asked === epoch) {
        markdown = text;
        paint({ text });
        onReport(text);
      }
    } catch (err) {
      if (!mine.signal.aborted && !destroyed && asked === epoch) paint({ error: err?.message || String(err) });
    } finally {
      if (controller === mine) { controller = null; onBusy(false); }
    }
  }

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      onToast('Copiado');
    } catch {
      onToast('No se pudo copiar: este navegador no da acceso al portapapeles.');
    }
  });

  downloadBtn.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `informe-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return {
    el: root,
    generate,
    show(text) {
      markdown = text;
      paint({ text });
    },
    reset() {
      epoch++;
      if (controller) { controller.abort(); controller = null; onBusy(false); }
      markdown = '';
      root.hidden = true;
      body.textContent = '';
      status.textContent = '';
    },
    destroy() { destroyed = true; controller?.abort(); },
  };
}
