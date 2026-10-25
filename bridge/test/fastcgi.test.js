import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastCGIClient, parseCgiOutput } from '../src/fastcgi.js';
import { fakeFpm } from './fake-fpm.js';

test('sends params and stdin, parses status, headers and body', async (t) => {
  const fpm = await fakeFpm((params, stdin) =>
    `Status: 201 Created\r\nX-Script: ${params.SCRIPT_FILENAME}\r\nX-Long: ${params.LONG.length}\r\n\r\nbody=${stdin}`);
  t.after(() => fpm.close());
  const c = new FastCGIClient({ host: '127.0.0.1', port: fpm.port });
  t.after(() => c.close());
  const res = await c.request({ SCRIPT_FILENAME: '/app/x.php', LONG: 'v'.repeat(300) }, Buffer.from('a=1'));
  assert.equal(res.status, 201);
  assert.deepEqual(res.headers.find(([k]) => k === 'X-Script'), ['X-Script', '/app/x.php']);
  assert.deepEqual(res.headers.find(([k]) => k === 'X-Long'), ['X-Long', '300']);
  assert.equal(res.body.toString(), 'body=a=1');
});

test('large stdin and stdout cross record boundaries', async (t) => {
  const fpm = await fakeFpm((_p, stdin) => 'Content-Type: text/plain\r\n\r\n' + stdin.length + ':' + 'x'.repeat(200000));
  t.after(() => fpm.close());
  const c = new FastCGIClient({ host: '127.0.0.1', port: fpm.port });
  t.after(() => c.close());
  const res = await c.request({}, Buffer.alloc(300000, 0x61));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, '300000:'.length + 200000);
});

// FPM gives each connection a worker until it closes. Idle keep-alive
// connections would pin every worker and starve new connections.
test('more concurrent requests than FPM workers all complete', async (t) => {
  const fpm = await fakeFpm(() => 'Status: 200\r\n\r\nok', { maxWorkers: 2, delayMs: 20 });
  t.after(() => fpm.close());
  const c = new FastCGIClient({ host: '127.0.0.1', port: fpm.port, timeoutMs: 2000 });
  t.after(() => c.close());
  for (let round = 0; round < 3; round++) {
    const results = await Promise.all(Array.from({ length: 6 }, () => c.request({}, Buffer.alloc(0))));
    assert.ok(results.every((r) => r.status === 200));
  }
});

test('no idle connection is left holding an FPM worker', async (t) => {
  const fpm = await fakeFpm(() => 'Status: 200\r\n\r\nok', { maxWorkers: 1 });
  t.after(() => fpm.close());
  const c = new FastCGIClient({ host: '127.0.0.1', port: fpm.port, timeoutMs: 1000 });
  t.after(() => c.close());
  await c.request({}, Buffer.alloc(0));
  const other = new FastCGIClient({ host: '127.0.0.1', port: fpm.port, timeoutMs: 1000 });
  t.after(() => other.close());
  assert.equal((await other.request({}, Buffer.alloc(0))).status, 200);
});

test('connection refused rejects', async () => {
  const c = new FastCGIClient({ host: '127.0.0.1', port: 1 });
  await assert.rejects(c.request({}, Buffer.alloc(0)), /ECONNREFUSED/);
  c.close();
});

test('timeout rejects', async (t) => {
  const net = await import('node:net');
  const server = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const c = new FastCGIClient({ host: '127.0.0.1', port: server.address().port, timeoutMs: 100 });
  await assert.rejects(c.request({}, Buffer.alloc(0)), /timed out/);
  c.close();
});

test('parseCgiOutput: Location without Status is a 302', () => {
  const r = parseCgiOutput(Buffer.from('Location: /login\r\n\r\n'));
  assert.equal(r.status, 302);
});

test('parseCgiOutput: bare LF separators', () => {
  const r = parseCgiOutput(Buffer.from('Status: 404 Not Found\nContent-Type: text/html\n\nnope'));
  assert.equal(r.status, 404);
  assert.equal(r.body.toString(), 'nope');
});

test('parseCgiOutput: repeated Set-Cookie headers are kept', () => {
  const r = parseCgiOutput(Buffer.from('Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n'));
  assert.deepEqual(r.headers.filter(([k]) => k === 'Set-Cookie').map(([, v]) => v), ['a=1', 'b=2']);
});
