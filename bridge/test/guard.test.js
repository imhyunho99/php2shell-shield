import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectRequest, scrubSetCookies } from '../src/guard.js';

const mp = (parts, boundary = 'XB') =>
  Buffer.from(parts.map((p) => `--${boundary}\r\n${p.headers.join('\r\n')}\r\n\r\n${p.body ?? ''}\r\n`).join('') + `--${boundary}--\r\n`);
const field = (name, body = 'v') => ({ headers: [`Content-Disposition: form-data; name="${name}"`], body });
const CT = { 'content-type': 'multipart/form-data; boundary=XB' };

test('normal multipart passes', () => {
  assert.equal(inspectRequest(CT, mp([field('title'), field('user[address][city]')])), null);
});

test('non-multipart passes', () => {
  assert.equal(inspectRequest({ 'content-type': 'application/json' }, Buffer.from('{}')), null);
});

test('upload progress field is refused, case-insensitively', () => {
  for (const name of ['PHP_SESSION_UPLOAD_PROGRESS', 'php_session_upload_progress']) {
    assert.equal(inspectRequest(CT, mp([field(name)])).rule, 'upload-progress-field');
  }
});

test('custom progress field name', () => {
  assert.equal(inspectRequest(CT, mp([field('UP')]), { progressFields: ['UP'] }).rule, 'upload-progress-field');
});

test('too many headers in one part', () => {
  const headers = ['Content-Disposition: form-data; name="a"', ...Array.from({ length: 20 }, (_, i) => `X-${i}: v`)];
  const r = inspectRequest(CT, mp([{ headers }]));
  assert.equal(r.rule, 'part-headers');
  assert.equal(r.status, 431);
});

test('oversized part header', () => {
  const r = inspectRequest(CT, mp([{ headers: [`Content-Disposition: form-data; name="a"; filename="${'a'.repeat(5000)}"`] }]));
  assert.equal(r.rule, 'part-headers');
});

test('deep nesting', () => {
  assert.equal(inspectRequest(CT, mp([field('a' + '[x]'.repeat(9))])).rule, 'field-nesting');
});

test('too many parts', () => {
  assert.equal(inspectRequest(CT, mp(Array.from({ length: 11 }, (_, i) => field('f' + i))), { maxParts: 10 }).rule, 'too-many-parts');
});

test('malformed multipart fails closed', () => {
  for (const body of ['--XB\r\nContent-Disposition: form-data; name="a"\r\n\r\nno end', 'garbage', '--XB\r\nno blank line\r\n--XB--\r\n']) {
    assert.equal(inspectRequest(CT, Buffer.from(body)).rule, 'malformed-multipart', body);
  }
});

test('multipart content-type without boundary fails closed', () => {
  assert.equal(inspectRequest({ 'content-type': 'multipart/form-data' }, Buffer.from('x')).rule, 'malformed-multipart');
  assert.equal(inspectRequest({ 'content-type': 'text/plain; x=multipart' }, Buffer.from('x')).rule, 'malformed-multipart');
});

test('blockMultipart', () => {
  assert.equal(inspectRequest(CT, mp([field('a')]), { blockMultipart: true }).rule, 'multipart-blocked');
});

test('quoted boundary', () => {
  assert.equal(inspectRequest({ 'content-type': 'multipart/form-data; boundary="XB"' }, mp([field('a')])), null);
});

test('scrubSetCookies drops invalid session ids and keeps the rest', () => {
  const { cookies, leaks } = scrubSetCookies([
    'PHPSESSID=abc123,-x; path=/',
    'theme=dark',
    'PHPSESSID=%00%7F%A8secret; path=/',
    'phpsessid=' + 'a'.repeat(300),
    'PHPSESSID=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT',
  ]);
  assert.deepEqual(cookies, ['PHPSESSID=abc123,-x; path=/', 'theme=dark', 'PHPSESSID=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT']);
  assert.equal(leaks.length, 2);
});

test('scrubSetCookies with a custom session name', () => {
  const { cookies } = scrubSetCookies(['SID=%00', 'PHPSESSID=%00'], { sessionCookies: ['SID'] });
  assert.deepEqual(cookies, ['PHPSESSID=%00']);
});
