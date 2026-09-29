// Static file server for local development. localhost is a secure context, so
// getUserMedia works without HTTPS. Exported for Tasks 4 and 7, which start it
// in-process rather than spawning a CLI.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.txt': 'text/plain',
};

function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
}

// Rejects any request path that would resolve outside the served root, such as
// `..` segments or an absolute path smuggled into the URL.
function resolveSafe(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = resolve(root, relative);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export function serve({ root, port = 5173, host = '127.0.0.1' } = {}) {
  const absRoot = resolve(root);
  const server = createServer(async (req, res) => {
    const target = resolveSafe(absRoot, req.url || '/');
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Not found');
      return;
    }
    try {
      const info = await stat(target);
      const filePath = info.isDirectory() ? join(target, 'index.html') : target;
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Not found');
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 5173;
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  serve({ root, port }).then((server) => {
    const addr = server.address();
    console.log(`Serving ${root} at http://127.0.0.1:${addr.port}`);
  });
}
