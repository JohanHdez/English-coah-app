import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serve } from './serve.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('every response carries the same policy as the index.html meta', async () => {
  const meta = readFileSync(`${ROOT}index.html`, 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const server = await serve({ root: ROOT, port: 0 });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/', '/embed-worker.js', '/preview-worker.js', '/sw.js']) {
      const res = await fetch(base + path);
      assert.equal(res.headers.get('content-security-policy'), meta, path);
    }
  } finally {
    server.close();
  }
});
