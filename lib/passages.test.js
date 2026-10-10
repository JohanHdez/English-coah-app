import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPassages, tokenize, bm25Index, search } from './passages.js';

const sentence = (i) => `Sentence number ${i} talks about topic ${i} in some detail.`;

test('short text is one passage', () => {
  assert.deepEqual(splitPassages('Hello there.\n\nSecond paragraph.'), ['Hello there.\n\nSecond paragraph.']);
});

test('empty or blank text has no passages', () => {
  assert.deepEqual(splitPassages(''), []);
  assert.deepEqual(splitPassages('  \n\n \n'), []);
});

test('passages stay near the target and break on paragraph boundaries', () => {
  const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ` + 'word '.repeat(40).trim() + '.');
  const out = splitPassages(paras.join('\n\n'), { target: 700, overlap: 0 });
  assert.ok(out.length > 1);
  for (const p of out) assert.ok(p.length <= 700, `passage of ${p.length}`);
  for (const p of out) assert.match(p, /^Paragraph \d+\./);
});

test('a paragraph longer than the target is split at sentence ends', () => {
  const para = Array.from({ length: 30 }, (_, i) => sentence(i)).join(' ');
  const out = splitPassages(para, { target: 300, overlap: 0 });
  assert.ok(out.length > 1);
  for (const p of out) {
    assert.ok(p.length <= 300);
    assert.match(p, /^Sentence number \d+/);
    assert.match(p, /detail\.$/);
  }
});

test('a sentence longer than the target is split between words', () => {
  const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
  const out = splitPassages(long, { target: 100, overlap: 0 });
  for (const p of out) {
    assert.ok(p.length <= 100);
    assert.match(p, /^w\d+( w\d+)*$/);
  }
  assert.equal(out.join(' '), long);
});

test('consecutive passages overlap by whole sentences up to the overlap budget', () => {
  const para = Array.from({ length: 30 }, (_, i) => sentence(i)).join(' ');
  const out = splitPassages(para, { target: 300, overlap: 100 });
  for (let i = 1; i < out.length; i++) {
    const first = out[i].match(/^Sentence number \d+[^.]*\./)[0];
    assert.ok(out[i - 1].endsWith(first), `passage ${i} starts with the end of passage ${i - 1}`);
    assert.ok(first.length <= 100);
  }
});

test('no text is lost: every sentence appears in some passage', () => {
  const text = Array.from({ length: 40 }, (_, i) => sentence(i) + (i % 5 === 4 ? '\n\n' : ' ')).join('');
  const out = splitPassages(text, { target: 250, overlap: 60 });
  for (let i = 0; i < 40; i++) assert.ok(out.some((p) => p.includes(sentence(i))), `sentence ${i}`);
});

test('tokenize lowercases, folds accents, drops English and Spanish stopwords', () => {
  assert.deepEqual(tokenize('The Migración of the PAYMENTS system'), ['migra', 'pay', 'system']);
  assert.deepEqual(tokenize('Lideré el equipo de pagos en Bogotá'), ['lider', 'equipo', 'pago', 'bogota']);
});

test('tokenize keeps numbers and splits on punctuation', () => {
  assert.deepEqual(tokenize('PostgreSQL, Redis & Kafka (2019–2023)'), ['postgresql', 'redis', 'kafka', '2019', '2023']);
});

test('search ranks the passage that matches the query first', () => {
  const passages = [
    'Led the payment migration from a monolith to services at Acme in 2021.',
    'Databases: PostgreSQL, MySQL and Redis. Some MongoDB.',
    'Hobbies include running, cooking and travelling with family.',
  ];
  const index = bm25Index(passages);
  assert.equal(search(index, 'Tell me about the payment migration you led')[0].index, 0);
  assert.equal(search(index, 'Which databases have you used?')[0].index, 1);
  assert.equal(search(index, '¿Qué bases de datos has usado? PostgreSQL')[0].index, 1);
});

test('search returns at most k hits, best first, with the passage text', () => {
  const passages = ['alpha beta', 'alpha', 'beta gamma', 'delta'];
  const hits = search(bm25Index(passages), 'alpha beta', { k: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].index, 0);
  assert.equal(hits[0].passage, 'alpha beta');
  assert.ok(hits[0].score >= hits[1].score);
});

test('search leaves out passages with no shared term and handles empty queries', () => {
  const index = bm25Index(['alpha', 'beta']);
  assert.deepEqual(search(index, 'gamma'), []);
  assert.deepEqual(search(index, 'the of and'), []);
  assert.deepEqual(search(bm25Index([]), 'alpha'), []);
});

test('bm25Index accepts passage records with a text field', () => {
  const hits = search(bm25Index([{ id: 'a', text: 'kafka streams' }, { id: 'b', text: 'react' }]), 'Kafka');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].index, 0);
  assert.deepEqual(hits[0].passage, { id: 'a', text: 'kafka streams' });
});

test('rarer terms weigh more than common ones', () => {
  const passages = ['python python', 'python', 'python', 'python kubernetes'];
  assert.equal(search(bm25Index(passages), 'python kubernetes')[0].index, 3);
});

test('a long paragraph of unpunctuated lines is split between lines, keeping them', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `Skill ${i} - tool ${i}, framework ${i}`);
  const out = splitPassages(lines.join('\n'), { target: 200, overlap: 0 });
  assert.ok(out.length > 1);
  for (const p of out) {
    assert.ok(p.length <= 200);
    for (const line of p.split('\n')) assert.match(line, /^Skill \d+ - tool \d+, framework \d+$/);
  }
  assert.equal(out.join('\n'), lines.join('\n'));
});

// CPU time of this process, not wall time: the gate runs test files in parallel,
// often beside a Chrome harness, and the quadratic versions took over 60 s.
const elapsed = (fn) => { const t0 = process.cpuUsage(); fn(); const d = process.cpuUsage(t0); return (d.user + d.system) / 1000; };
const TWO_MB = 2 * 1024 * 1024;

test('2 MB of spaces splits in under 200 ms', () => {
  let out;
  const ms = elapsed(() => { out = splitPassages(`a${' '.repeat(TWO_MB)}b`); });
  assert.deepEqual(out, ['a b']);
  assert.ok(ms < 200, `${ms.toFixed(0)} ms`);
});

test('2 MB of "\\t \\n" interleavings splits in under 200 ms', () => {
  const ms = elapsed(() => splitPassages(`a${'\t \n'.repeat(Math.floor(TWO_MB / 3))}b ${'\t '.repeat(TWO_MB / 4)}c`));
  assert.ok(ms < 200, `${ms.toFixed(0)} ms`);
});

test('prose followed by a long run of spaces splits in under 200 ms, prose kept', () => {
  const prose = Array.from({ length: 14 }, (_, i) => sentence(i)).join(' ');
  let out;
  const ms = elapsed(() => { out = splitPassages(`${prose} then${' '.repeat(80000)}more`); });
  assert.ok(ms < 200, `${ms.toFixed(0)} ms`);
  assert.ok(out.join(' ').includes(sentence(13)));
});

// 100 000 units: linear, but about 275 ms of CPU on a loaded machine (measured).
test('200 000 one-character words split in under 1 s', () => {
  const ms = elapsed(() => splitPassages('a '.repeat(100000)));
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

test('a paragraph of 150 000 words does not overflow the stack', () => {
  const out = splitPassages('ab '.repeat(150000));
  assert.ok(out.length > 600);
});

test('tokenize stems English and Spanish conservatively', () => {
  const same = (a, b) => assert.deepEqual(tokenize(a), tokenize(b), `${a} / ${b}`);
  same('databases', 'database');
  same('engineers', 'engineer');
  same('migrated', 'migrate');
  same('contrataciones', 'contratación');
  same('rápidamente', 'rápida');
  assert.deepEqual(tokenize('Redis status business'), ['redis', 'status', 'business']);
  assert.deepEqual(tokenize('led sing red'), ['led', 'sing', 'red']);
});
