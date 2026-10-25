import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unserialize, decodeSession } from '../src/unserialize.js';

test('scalars', () => {
  assert.equal(unserialize('i:42;'), 42);
  assert.equal(unserialize('i:-7;'), -7);
  assert.equal(unserialize('d:1.5;'), 1.5);
  assert.equal(unserialize('b:1;'), true);
  assert.equal(unserialize('b:0;'), false);
  assert.equal(unserialize('N;'), null);
  assert.equal(unserialize('s:5:"hello";'), 'hello');
});

test('string length counts bytes, not characters', () => {
  // "한글" is 6 bytes in UTF-8
  assert.equal(unserialize('s:6:"한글";'), '한글');
  assert.equal(unserialize('s:3:"a;b";'), 'a;b');
  assert.equal(unserialize('s:4:"a"}b";'), 'a"}b');
});

test('list array becomes a JS array', () => {
  assert.deepEqual(unserialize('a:2:{i:0;s:1:"a";i:1;s:1:"b";}'), ['a', 'b']);
});

test('assoc array becomes an object', () => {
  assert.deepEqual(unserialize('a:2:{s:4:"name";s:3:"kim";s:3:"age";i:30;}'), { name: 'kim', age: 30 });
});

test('nested arrays', () => {
  assert.deepEqual(unserialize('a:1:{s:4:"user";a:2:{s:2:"id";i:7;s:5:"roles";a:1:{i:0;s:5:"admin";}}}'),
    { user: { id: 7, roles: ['admin'] } });
});

test('objects keep class name and strip visibility prefixes', () => {
  const s = 'O:4:"User":3:{s:2:"id";i:1;s:7:"\0*\0name";s:3:"lee";s:10:"\0User\0pass";s:1:"x";}';
  assert.deepEqual(unserialize(s), { __class: 'User', id: 1, name: 'lee', pass: 'x' });
});

test('malformed input throws', () => {
  for (const bad of ['s:10:"short";', 'a:2:{i:0;i:1;}', 'x:1;', 'i:1', '']) {
    assert.throws(() => unserialize(bad), /unserialize/, bad);
  }
});

test('decodeSession: default php handler format', () => {
  const raw = 'user_id|i:7;cart|a:1:{i:0;s:3:"tea";}flash|N;';
  assert.deepEqual(decodeSession(raw), { user_id: 7, cart: ['tea'], flash: null });
});

test('decodeSession: php_serialize handler format', () => {
  assert.deepEqual(decodeSession('a:1:{s:7:"user_id";i:7;}', 'php_serialize'), { user_id: 7 });
});

test('decodeSession: empty session', () => {
  assert.deepEqual(decodeSession(''), {});
});
