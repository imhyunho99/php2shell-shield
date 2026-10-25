#!/usr/bin/env node
// php-bridge: run Node in front of a PHP-FPM app.
//
//   php-bridge --root /var/www/html --fpm 127.0.0.1:9000 --routes ./routes.mjs

import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createBridge } from '../src/index.js';

const HELP = `usage: php-bridge --root DIR --fpm HOST:PORT|/path/to.sock [options]

  --listen ADDR            where to listen (default :3000)
  --root DIR               document root on this machine (required)
  --fpm TARGET             PHP-FPM address, HOST:PORT or a unix socket path (required)
  --fpm-root DIR           document root as PHP-FPM sees it (default: --root)
  --front-controller FILE  send unknown paths here, e.g. index.php (Laravel, WordPress)
  --routes FILE            JS module whose default export receives the bridge
                           and registers Node routes: export default (b) => b.get(...)
  --session-path DIR       PHP session.save_path, to read sessions from Node
  --session-name NAME      PHP session.name (default PHPSESSID)
  --max-body BYTES         request body limit (default 16777216)
  --block-multipart        refuse all multipart (apps with no uploads)
  --no-guard               turn off the PHP2Shell checks
  --trust-proxy            trust X-Forwarded-For / X-Forwarded-Proto
  --stats-path PATH        serve migration stats as JSON at PATH (keep it private)
  --version`;

const { values: a } = parseArgs({
  options: {
    listen: { type: 'string', default: ':3000' },
    root: { type: 'string' },
    fpm: { type: 'string' },
    'fpm-root': { type: 'string' },
    'front-controller': { type: 'string' },
    routes: { type: 'string' },
    'session-path': { type: 'string' },
    'session-name': { type: 'string', default: 'PHPSESSID' },
    'max-body': { type: 'string', default: String(16 << 20) },
    'block-multipart': { type: 'boolean', default: false },
    'no-guard': { type: 'boolean', default: false },
    'trust-proxy': { type: 'boolean', default: false },
    'stats-path': { type: 'string' },
    version: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (a.version) {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  console.log(pkg.default.version);
  process.exit(0);
}
if (a.help || !a.root || !a.fpm) {
  console.error(HELP);
  process.exit(a.help ? 0 : 2);
}

const fpm = a.fpm.includes('/') ? { path: a.fpm } : parseHostPort(a.fpm);
const bridge = createBridge({
  root: a.root,
  fpmRoot: a['fpm-root'],
  fpm,
  frontController: a['front-controller'],
  maxBodyBytes: Number(a['max-body']),
  trustProxy: a['trust-proxy'],
  guard: a['no-guard'] ? false : { blockMultipart: a['block-multipart'], sessionCookies: [a['session-name']] },
  session: a['session-path'] ? { savePath: a['session-path'], name: a['session-name'] } : undefined,
});

if (a['stats-path']) {
  bridge.get(a['stats-path'], (_req, res) => res.json(bridge.stats()));
}
if (a.routes) {
  const mod = await import(pathToFileURL(path.resolve(a.routes)).href);
  await mod.default(bridge);
}

const { host, port } = parseHostPort(a.listen);
const server = http.createServer(bridge.handler);
server.listen(port, host, () => {
  console.error(`php-bridge listening on ${a.listen} -> ${a.fpm} (root ${a.root})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    bridge.close();
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

function parseHostPort(s) {
  const i = s.lastIndexOf(':');
  const host = i > 0 ? s.slice(0, i) : undefined;
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`bad address ${s}`);
    process.exit(2);
  }
  return { host, port };
}
