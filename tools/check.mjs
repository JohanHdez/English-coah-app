// The whole gate: no CI runs this project, so one script has to catch what CI would.
// Syntax on every shipped script, every file the shell actually references, and the
// full unit-test suite. Exits non-zero on the first kind of failure or the last.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXCLUDED_DIRS = new Set(['.git', 'vendor', '.superpowers', 'node_modules']);
const EXCLUDED_PATHS = new Set(['e2e/fixtures', 'e2e/results', 'e2e/.profile']);

let failed = false;

function fail(message) {
  console.error(message);
  failed = true;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || EXCLUDED_PATHS.has(rel)) continue;
      out.push(...walk(full));
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// 1. Syntax on every shipped script.
const allScripts = walk(ROOT);
for (const file of allScripts) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`[check] syntax error in ${relative(ROOT, file)}:\n${result.stderr}`);
  }
}

// 2. Every path the shell actually references exists.
function localPaths(html) {
  const paths = [];
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const p = m[1];
    if (/^(https?:)?\/\//.test(p) || p.startsWith('data:')) continue;
    paths.push(p);
  }
  return paths;
}

const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
for (const p of localPaths(indexHtml)) {
  if (!existsSync(resolve(ROOT, p))) fail(`[check] index.html references missing file: ${p}`);
}

const swSrc = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const shellMatch = swSrc.match(/SHELL_FILES\s*=\s*\[([\s\S]*?)\]/);
const shellFiles = shellMatch
  ? [...shellMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
  : [];
if (shellFiles.length === 0) fail('[check] sw.js has no SHELL_FILES precache list');
for (const p of shellFiles) {
  const target = p === './' ? ROOT : resolve(ROOT, p);
  if (!existsSync(target)) fail(`[check] sw.js precaches a missing file: ${p}`);
}

// 3. The full unit-test suite.
function glob(dir, pattern) {
  const full = resolve(ROOT, dir);
  if (!existsSync(full) || !statSync(full).isDirectory()) return [];
  return readdirSync(full)
    .filter((name) => pattern.test(name))
    .map((name) => join(full, name));
}

const testFiles = [
  ...glob('lib', /\.test\.js$/),
  ...glob('.', /\.test\.js$/),
  ...glob('e2e', /\.test\.js$/),
];

let testCount = 0;
let failCount = 0;
if (testFiles.length > 0) {
  const result = spawnSync(process.execPath, ['--test', ...testFiles], { encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const testsMatch = result.stdout.match(/^ℹ tests (\d+)/m);
  const failMatch = result.stdout.match(/^ℹ fail (\d+)/m);
  testCount = testsMatch ? Number(testsMatch[1]) : 0;
  failCount = failMatch ? Number(failMatch[1]) : (result.status !== 0 ? 1 : 0);
  if (result.status !== 0 || failCount > 0) fail('[check] unit tests failed');
}

console.log(`${testFiles.length} files · ${testCount} tests · ${failCount} failing`);
process.exit(failed ? 1 : 0);
