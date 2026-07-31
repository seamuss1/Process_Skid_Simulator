#!/usr/bin/env node
/**
 * Zero-dependency static file server for the Process Skid Simulator.
 *
 * ES modules require an http origin (they will not load from file://), so the
 * app is served rather than opened directly. No dependencies, no build step.
 *
 *   node tools/serve.js [--port 8080] [--no-open]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function parseArgs(argv) {
  const opts = { port: 8080, open: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') opts.port = Number(argv[++i]);
    else if (argv[i] === '--no-open') opts.open = false;
  }
  return opts;
}

/** Resolve a URL path to an on-disk path, refusing anything that escapes ROOT. */
function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  if (rel.split(/[/\\]/).includes('..')) return null;
  const abs = join(ROOT, rel);
  if (abs !== ROOT.replace(/[\\/]$/, '') && !abs.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  try {
    let target = resolveSafe(req.url || '/');
    if (!target) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden');
    }

    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`404 Not Found: ${req.url}`);
    }

    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      // Simulator source changes constantly during development; never cache.
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err.message}`);
  }
});

const { port, open } = parseArgs(process.argv.slice(2));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is in use. Try:  node tools/serve.js --port ${port + 1}`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => {
  const url = `http://localhost:${port}/`;
  console.log(`\n  Process Skid Simulator\n  serving ${ROOT}\n  ${url}\n\n  Ctrl+C to stop\n`);
  if (open) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
