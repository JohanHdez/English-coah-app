// The document reader in headless Chrome, under the app's CSP (tools/serve.mjs sends
// it as a header): the synthetic CV as PDF, DOCX and TXT, the two broken files, the
// known sentence found by search, any CSP violation or console error, and how long
// the 2-page PDF takes cold (pdf.js and its worker loading) and warm.
//
// Usage: caffeinate -i node e2e/docs-check.mjs   (own profile, under e2e/fixtures/)

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { Chrome } from './cdp.mjs';
import { serve } from '../tools/serve.mjs';
import { writeDocsFixtures, KNOWN_SENTENCE } from './docs-fixtures.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const WARM_RUNS = 5;

writeDocsFixtures();
const server = await serve({ root: ROOT, port: 0 });
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = join(ROOT, 'e2e', 'fixtures', '.chrome-docs');
rmSync(profile, { recursive: true, force: true });
const chrome = await Chrome.launch({ profile, headless: true });

const problems = [];
let failed = false;
try {
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const session = await chrome.attach(targetId);
  chrome.on((method, params, sid) => {
    if (sid !== session) return;
    if (method === 'Runtime.exceptionThrown') problems.push(`exception: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text}`);
    if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(params.type)) {
      problems.push(`console.${params.type}: ${params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (method === 'Log.entryAdded' && ['error', 'warning'].includes(params.entry.level)) problems.push(`log.${params.entry.level}: ${params.entry.text} ${params.entry.url || ''}`);
  });
  await chrome.send('Runtime.enable', {}, session);
  await chrome.send('Log.enable', {}, session);
  await chrome.send('Page.enable', {}, session);
  // Any same-origin document gets the policy as a header; this one runs no script of its own.
  await chrome.send('Page.navigate', { url: `${origin}/e2e/fixtures/docs/cv.txt` }, session);
  await chrome.waitFor((m, _p, sid) => sid === session && m === 'Page.loadEventFired', { label: 'load' });

  const results = await chrome.evaluate(session, `(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective + ' ' + e.blockedURI));
    const { extractText } = await import('/docs-extract.js');
    const { splitPassages, bm25Index, search } = await import('/lib/passages.js');
    const fileOf = async (name) => {
      const blob = await (await fetch('/e2e/fixtures/docs/' + name)).blob();
      return new File([blob], name);
    };
    // A PDF wraps a long sentence over two lines.
    const flat = (s) => s.replace(/\\s+/g, ' ');
    const run = async (name) => {
      const file = await fileOf(name);
      const t0 = performance.now();
      try {
        const r = await extractText(file);
        const ms = performance.now() - t0;
        const passages = splitPassages(r.text);
        const hit = search(bm25Index(passages), 'Tell me about the payment migration you led')[0];
        return { name, ok: true, ms, pages: r.pages ?? null, chars: r.text.length, passages: passages.length,
          found: flat(r.text).includes(${JSON.stringify(KNOWN_SENTENCE)}),
          topHasSentence: !!hit && flat(hit.passage).includes(${JSON.stringify(KNOWN_SENTENCE)}),
          head: r.text.slice(0, 80), text: r.text };
      } catch (e) {
        return { name, ok: false, ms: performance.now() - t0, error: e.message };
      }
    };
    const out = { runs: [] };
    out.runs.push(await run('cv.pdf'));
    out.warm = [];
    for (let i = 0; i < ${WARM_RUNS}; i++) out.warm.push((await run('cv.pdf')).ms);
    for (const name of ['cv.docx', 'cv.txt', 'malformed.pdf', 'not-a-zip.docx']) out.runs.push(await run(name));
    out.violations = violations;
    return out;
  })()`);

  const expect = {
    'cv.pdf': (r) => r.ok && r.pages === 2 && r.found && r.topHasSentence,
    'cv.docx': (r) => r.ok && r.found && r.topHasSentence,
    'cv.txt': (r) => r.ok && r.found && r.topHasSentence,
    'malformed.pdf': (r) => !r.ok && r.error === '[documentos] No se pudo leer el PDF.',
    'not-a-zip.docx': (r) => !r.ok && r.error === '[documentos] No se pudo leer el documento de Word.',
  };
  for (const r of results.runs) {
    const pass = expect[r.name](r);
    if (!pass) failed = true;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${r.name.padEnd(15)} ${r.ms.toFixed(1).padStart(7)} ms  ${r.ok
      ? `pages=${r.pages} chars=${r.chars} passages=${r.passages} sentence=${r.found} top=${r.topHasSentence} «${r.head.replace(/\n/g, ' / ')}»`
      : r.error}`);
  }
  if (process.env.DOCS_DUMP) console.log(results.runs[0].text);
  const warm = [...results.warm].sort((a, b) => a - b);
  console.log(`cv.pdf (2 pages): cold ${results.runs[0].ms.toFixed(1)} ms; warm ×${WARM_RUNS} median ${warm[Math.floor(warm.length / 2)].toFixed(1)} ms, min ${warm[0].toFixed(1)}, max ${warm.at(-1).toFixed(1)}`);
  console.log(`CSP violations: ${results.violations.length ? results.violations.join('; ') : 'none'}`);
  console.log(`console errors/warnings: ${problems.length ? '\n  ' + problems.join('\n  ') : 'none'}`);
  if (results.violations.length) failed = true;
} finally {
  await chrome.close();
  server.close();
}
process.exit(failed ? 1 : 0);
