// createBridge puts Node in front of a PHP app. Routes registered on the
// bridge run in Node; every other request is a static file or goes to
// PHP-FPM, so an app can move to Node one route at a time.

import fs from 'node:fs';
import path from 'node:path';
import { FastCGIClient } from './fastcgi.js';
import { inspectRequest, scrubSetCookies, DEFAULTS as GUARD_DEFAULTS } from './guard.js';
import { Router } from './router.js';
import { SessionReader } from './session.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

export function createBridge(opts) {
  if (!opts?.root) throw new Error('php-bridge: root is required');
  if (!opts.fpm) throw new Error('php-bridge: fpm is required ({ host, port } or { path })');

  const root = path.resolve(opts.root);
  const fpmRoot = (opts.fpmRoot ?? root).replace(/\/+$/, '');
  const frontController = opts.frontController ?? null;
  const maxBodyBytes = opts.maxBodyBytes ?? 16 << 20;
  const guard = opts.guard === false ? null : { ...GUARD_DEFAULTS, ...opts.guard };
  const onEvent = opts.onEvent ?? ((e) => console.error(JSON.stringify({ time: new Date().toISOString(), ...e })));
  const fcgi = new FastCGIClient({ ...opts.fpm, timeoutMs: opts.fpmTimeoutMs });
  const sessions = opts.session ? new SessionReader({ name: guard?.sessionCookies?.[0], ...opts.session }) : null;
  const router = new Router();
  const counts = { node: {}, php: {}, static: 0 };

  const emit = (req, rule, detail) =>
    onEvent({ rule, detail, method: req.method, path: req.url, remote: req.socket.remoteAddress });

  async function handler(req, res) {
    try {
      await handle(req, res);
    } catch (err) {
      emit(req, 'internal-error', err.message);
      if (!res.headersSent) send(res, 500, 'Internal Server Error');
      else res.destroy();
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://bridge.invalid');

    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBodyBytes) {
      emit(req, 'body-too-large', `content-length ${declared}`);
      return send(res, 413, 'Payload Too Large');
    }
    const body = await readBody(req, maxBodyBytes);
    if (body === null) {
      emit(req, 'body-too-large', `body > ${maxBodyBytes}`);
      return send(res, 413, 'Payload Too Large');
    }

    if (guard) {
      const headers = { ...req.headers };
      const cts = req.headersDistinct?.['content-type'];
      if (cts && cts.length > 1) headers['content-type'] = cts;
      const verdict = inspectRequest(headers, body, guard);
      if (verdict) {
        emit(req, verdict.rule, verdict.detail);
        return send(res, verdict.status, verdict.rule);
      }
    }

    const route = router.match(req.method, url.pathname);
    if (route) {
      counts.node[route.key] = (counts.node[route.key] ?? 0) + 1;
      req.params = route.params;
      req.query = url.searchParams;
      req.body = body;
      req.phpSession = () => (sessions ? sessions.read(req.headers.cookie) : Promise.resolve(null));
      res.json = (value, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      };
      return await route.handler(req, res);
    }

    const target = resolve(url.pathname);
    if (target.error) return send(res, target.error, target.error === 403 ? 'Forbidden' : 'Not Found');
    if (target.static) {
      counts.static++;
      return serveStatic(req, res, target.static);
    }
    counts.php[target.script] = (counts.php[target.script] ?? 0) + 1;
    return runPhp(req, res, url, body, target);
  }

  // resolve maps a URL path to a static file, a PHP script, or an error.
  function resolve(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return { error: 400 };
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return { error: 400 };
    const segments = decoded.split('/').filter(Boolean);
    if (segments.some((s) => s === '..')) return { error: 404 };
    if (segments.some((s) => s.startsWith('.') && s !== '.well-known')) return { error: 403 };

    // /script.php/extra -> script plus PATH_INFO
    for (let i = 0; i < segments.length; i++) {
      if (!segments[i].endsWith('.php')) continue;
      const rel = segments.slice(0, i + 1).join('/');
      if (isFile(path.join(root, rel))) {
        const rest = segments.slice(i + 1);
        return { script: '/' + rel, pathInfo: rest.length ? '/' + rest.join('/') : '' };
      }
    }

    const local = path.join(root, ...segments);
    if (local !== root && !local.startsWith(root + path.sep)) return { error: 404 };
    const stat = statSafe(local);
    if (stat?.isFile()) return { static: local };
    if (stat?.isDirectory()) {
      const dir = segments.length ? '/' + segments.join('/') : '';
      if (isFile(path.join(local, 'index.php'))) return { script: `${dir}/index.php`, pathInfo: '' };
      if (isFile(path.join(local, 'index.html'))) return { static: path.join(local, 'index.html') };
    }
    if (frontController && isFile(path.join(root, frontController))) {
      return { script: '/' + frontController.replace(/^\/+/, ''), pathInfo: '' };
    }
    return { error: 404 };
  }

  async function runPhp(req, res, url, body, { script, pathInfo }) {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const https = req.socket.encrypted || (opts.trustProxy && req.headers['x-forwarded-proto'] === 'https');
    const params = {
      GATEWAY_INTERFACE: 'CGI/1.1',
      SERVER_SOFTWARE: 'php-bridge',
      SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
      REQUEST_METHOD: req.method,
      REQUEST_URI: req.url,
      QUERY_STRING: url.search.slice(1),
      DOCUMENT_ROOT: fpmRoot,
      DOCUMENT_URI: script,
      SCRIPT_NAME: script,
      SCRIPT_FILENAME: fpmRoot + script,
      PATH_INFO: pathInfo || undefined,
      CONTENT_TYPE: req.headers['content-type'],
      CONTENT_LENGTH: body.length ? String(body.length) : undefined,
      REMOTE_ADDR: opts.trustProxy ? forwardedFor(req) : req.socket.remoteAddress,
      REMOTE_PORT: String(req.socket.remotePort ?? ''),
      SERVER_ADDR: req.socket.localAddress,
      SERVER_PORT: String(req.socket.localPort ?? ''),
      SERVER_NAME: host,
      HTTPS: https ? 'on' : undefined,
      REDIRECT_STATUS: '200',
    };
    for (const [name, value] of Object.entries(req.headers)) {
      // httpoxy, and names with '_' that could pose as another header
      if (name === 'proxy' || name.includes('_') || name === 'content-type' || name === 'content-length') continue;
      params['HTTP_' + name.toUpperCase().replace(/-/g, '_')] = Array.isArray(value) ? value.join(', ') : value;
    }

    let out;
    try {
      out = await fcgi.request(params, body);
    } catch (err) {
      emit(req, 'fpm-error', err.message);
      return send(res, 502, 'Bad Gateway');
    }
    if (out.stderr) emit(req, 'php-stderr', out.stderr.slice(0, 500));

    const headers = {};
    const setCookies = [];
    for (const [k, v] of out.headers) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk === 'content-length') continue;
      if (lk === 'set-cookie') setCookies.push(v);
      else headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
    }
    if (setCookies.length) {
      if (guard) {
        const { cookies, leaks } = scrubSetCookies(setCookies, guard);
        for (const l of leaks) emit(req, 'session-cookie-leak', `${l.name} cookie with ${l.length}-byte invalid value; restart PHP workers`);
        if (cookies.length) headers['Set-Cookie'] = cookies;
      } else {
        headers['Set-Cookie'] = setCookies;
      }
    }
    headers['Content-Length'] = out.body.length;
    res.writeHead(out.status, headers);
    res.end(req.method === 'HEAD' ? undefined : out.body);
  }

  function serveStatic(req, res, file) {
    const stat = fs.statSync(file);
    const mtime = stat.mtime.toUTCString();
    if (req.headers['if-modified-since'] === mtime) {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Last-Modified': mtime,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const api = {
    handler,
    stats: () => structuredClone(counts),
    close: () => fcgi.close(),
  };
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
    api[m] = (pattern, fn) => {
      router.add(m.toUpperCase(), pattern, fn);
      return api;
    };
  }
  return api;
}

function readBody(req, limit) {
  if (req.readableEnded && req.headers['content-length'] !== '0' && (req.headers['content-length'] || req.headers['transfer-encoding'])) {
    // A body parser mounted first already drained the stream; waiting for
    // 'end' would hang forever.
    return Promise.reject(new Error('php-bridge: request body was already read; mount php-bridge before any body parser'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forwardedFor(req) {
  const xff = req.headers['x-forwarded-for'];
  return xff ? xff.split(',')[0].trim() : req.socket.remoteAddress;
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text + '\n');
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function isFile(p) {
  return statSafe(p)?.isFile() ?? false;
}
