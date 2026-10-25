import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/index.js';
import { fakeFpm } from './fake-fpm.js';

let fpm, root, sessDir, server, base, bridge, events;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-root-'));
  sessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-sess-'));
  fs.writeFileSync(path.join(root, 'index.php'), '<?php');
  fs.writeFileSync(path.join(root, 'info.php'), '<?php');
  fs.writeFileSync(path.join(root, 'style.css'), 'body{}');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(root, 'blog'));
  fs.writeFileSync(path.join(root, 'blog', 'index.php'), '<?php');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'index.html'), '<h1>docs</h1>');
  fs.writeFileSync(path.join(sessDir, 'sess_abc123'), 'user_id|i:7;name|s:3:"kim";');

  fpm = await fakeFpm((params, stdin) => {
    if (params.SCRIPT_NAME === '/leak.php') return 'Set-Cookie: PHPSESSID=%00%A8secret\r\nSet-Cookie: ok=1\r\n\r\nx';
    return 'Content-Type: application/json\r\nX-Powered-By: PHP\r\n\r\n' + JSON.stringify({ params, body: stdin.toString() });
  });
  events = [];
  bridge = createBridge({
    root,
    fpmRoot: '/srv/app',
    fpm: { host: '127.0.0.1', port: fpm.port },
    frontController: 'index.php',
    session: { savePath: sessDir },
    maxBodyBytes: 1024,
    onEvent: (e) => events.push(e),
  });
  bridge.get('/api/users/:id', async (req, res) => {
    res.json({ id: req.params.id, q: req.query.get('q'), session: await req.phpSession() });
  });
  bridge.post('/api/echo', (req, res) => res.json({ body: req.body.toString() }));
  bridge.get('/api/boom', () => { throw new Error('boom'); });
  server = http.createServer(bridge.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  bridge.close();
  await new Promise((r) => server.close(r));
  await fpm.close();
});

const php = async (res) => (await res.json()).params;

test('node route handles migrated endpoint with params, query and php session', async () => {
  const res = await fetch(`${base}/api/users/42?q=hi`, { headers: { cookie: 'PHPSESSID=abc123' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: '42', q: 'hi', session: { user_id: 7, name: 'kim' } });
});

test('phpSession is null without a cookie or with a bad id', async () => {
  for (const cookie of ['', 'PHPSESSID=../../etc/passwd', 'PHPSESSID=nosuch']) {
    const res = await fetch(`${base}/api/users/1`, { headers: cookie ? { cookie } : {} });
    assert.equal((await res.json()).session, null, cookie);
  }
});

test('node route gets the body', async () => {
  const res = await fetch(`${base}/api/echo`, { method: 'POST', body: 'hello' });
  assert.deepEqual(await res.json(), { body: 'hello' });
});

test('node route errors become 500', async () => {
  assert.equal((await fetch(`${base}/api/boom`)).status, 500);
});

test('existing php script goes to FPM with the FPM-side path', async () => {
  const res = await fetch(`${base}/info.php?a=1&b=2`, { headers: { 'X-Custom': 'yes', Proxy: 'http://evil', 'X_Under': 'spoof' } });
  assert.equal(res.headers.get('x-powered-by'), 'PHP');
  const p = await php(res);
  assert.equal(p.SCRIPT_FILENAME, '/srv/app/info.php');
  assert.equal(p.SCRIPT_NAME, '/info.php');
  assert.equal(p.DOCUMENT_ROOT, '/srv/app');
  assert.equal(p.QUERY_STRING, 'a=1&b=2');
  assert.equal(p.REQUEST_URI, '/info.php?a=1&b=2');
  assert.equal(p.REQUEST_METHOD, 'GET');
  assert.equal(p.HTTP_X_CUSTOM, 'yes');
  assert.equal(p.HTTP_PROXY, undefined, 'httpoxy');
  assert.equal(p.HTTP_X_UNDER, undefined, 'underscore headers dropped');
});

test('POST body and content headers reach PHP', async () => {
  const res = await fetch(`${base}/info.php`, { method: 'POST', body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const j = await res.json();
  assert.equal(j.body, 'a=1');
  assert.equal(j.params.CONTENT_TYPE, 'application/x-www-form-urlencoded');
  assert.equal(j.params.CONTENT_LENGTH, '3');
});

test('unknown path falls back to the front controller', async () => {
  const p = await php(await fetch(`${base}/posts/hello-world?x=1`));
  assert.equal(p.SCRIPT_FILENAME, '/srv/app/index.php');
  assert.equal(p.REQUEST_URI, '/posts/hello-world?x=1');
});

test('PATH_INFO after a php script', async () => {
  const p = await php(await fetch(`${base}/info.php/extra/path`));
  assert.equal(p.SCRIPT_NAME, '/info.php');
  assert.equal(p.PATH_INFO, '/extra/path');
});

test('directory index: index.php then index.html', async () => {
  assert.equal((await php(await fetch(`${base}/blog/`))).SCRIPT_FILENAME, '/srv/app/blog/index.php');
  assert.equal(await (await fetch(`${base}/docs/`)).text(), '<h1>docs</h1>');
});

test('static files are served directly with a content type', async () => {
  const res = await fetch(`${base}/style.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/css/);
  assert.equal(await res.text(), 'body{}');
});

test('dotfiles and traversal never leak', async () => {
  for (const p of ['/.env', '/%2e%2e/%2e%2e/etc/passwd', '/blog/..%2f..%2fetc/passwd', '/a%00.php']) {
    const res = await fetch(base + p);
    const text = await res.text();
    assert.ok(!text.includes('SECRET') && !text.includes('root:'), p);
    assert.ok([400, 403, 404].includes(res.status) || JSON.parse(text).params.SCRIPT_FILENAME === '/srv/app/index.php', `${p} -> ${res.status}`);
  }
  assert.equal((await fetch(`${base}/.env`)).status, 403);
});

test('php source is never served as a static file', async () => {
  const res = await fetch(`${base}/index.php`);
  assert.ok(!(await res.text()).startsWith('<?php'));
});

test('guard refuses upload-progress multipart before anything runs', async () => {
  const fd = new FormData();
  fd.append('PHP_SESSION_UPLOAD_PROGRESS', 'x');
  const res = await fetch(`${base}/info.php`, { method: 'POST', body: fd });
  assert.equal(res.status, 403);
  assert.ok(events.some((e) => e.rule === 'upload-progress-field'));
});

test('oversized body is refused', async () => {
  const res = await fetch(`${base}/info.php`, { method: 'POST', body: 'a'.repeat(2048) });
  assert.equal(res.status, 413);
});

test('leaking session cookie is stripped from PHP responses', async () => {
  fs.writeFileSync(path.join(root, 'leak.php'), '<?php');
  const res = await fetch(`${base}/leak.php`);
  assert.deepEqual(res.headers.getSetCookie(), ['ok=1']);
  assert.ok(events.some((e) => e.rule === 'session-cookie-leak'));
});

test('stats show what still runs on PHP', async () => {
  const s = bridge.stats();
  assert.ok(s.node['GET /api/users/:id'] >= 1);
  assert.ok(s.php['/info.php'] >= 1);
  assert.ok(s.php['/index.php'] >= 1);
  assert.ok(s.static >= 1);
});

test('FPM down gives 502', async () => {
  const b = createBridge({ root, fpm: { host: '127.0.0.1', port: 1 }, onEvent: () => {} });
  const s = http.createServer(b.handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${s.address().port}/info.php`);
  assert.equal(res.status, 502);
  await new Promise((r) => s.close(r));
});

test('works as Express-style middleware: next() is ignored, unmatched goes to PHP', async () => {
  const s = http.createServer((req, res) => bridge.handler(req, res, () => assert.fail('next called')));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = await php(await fetch(`http://127.0.0.1:${s.address().port}/info.php`));
  assert.equal(p.SCRIPT_NAME, '/info.php');
  await new Promise((r) => s.close(r));
});

test('a body already consumed by another parser fails loudly instead of hanging', async () => {
  const s = http.createServer(async (req, res) => {
    for await (const _ of req); // what a body parser mounted first would do
    bridge.handler(req, res);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${s.address().port}/info.php`, { method: 'POST', body: 'a=1', signal: AbortSignal.timeout(3000) });
  assert.equal(res.status, 500);
  assert.ok(events.some((e) => /before any body parser/.test(e.detail ?? '')));
  await new Promise((r) => s.close(r));
});
