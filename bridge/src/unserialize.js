// Reads PHP's serialize() format and PHP session files.
//
// PHP string lengths count bytes, so parsing works on a Buffer, not a JS
// string. Objects come back as plain objects with a __class key; nothing is
// ever instantiated or executed.

export function unserialize(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const p = new Parser(buf);
  const value = p.value();
  if (p.pos !== buf.length) p.fail('trailing data');
  return value;
}

// decodeSession reads a session file body written by PHP's "php" (default)
// or "php_serialize" session.serialize_handler.
export function decodeSession(input, handler = 'php') {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (buf.length === 0) return {};
  if (handler === 'php_serialize') {
    const v = unserialize(buf);
    return Array.isArray(v) ? { ...v } : v;
  }
  if (handler !== 'php') throw new Error(`unserialize: unsupported session handler ${handler}`);
  const out = {};
  const p = new Parser(buf);
  while (p.pos < buf.length) {
    const bar = buf.indexOf(0x7c, p.pos); // '|'
    if (bar < 0) p.fail('missing | after session key');
    const key = buf.toString('utf8', p.pos, bar);
    p.pos = bar + 1;
    out[key] = p.value();
  }
  return out;
}

class Parser {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  fail(msg) {
    throw new Error(`unserialize: ${msg} at byte ${this.pos}`);
  }

  expect(ch) {
    if (this.buf[this.pos] !== ch.charCodeAt(0)) this.fail(`expected '${ch}'`);
    this.pos++;
  }

  // readUntil returns the text up to (not including) ch and skips ch.
  readUntil(ch) {
    const end = this.buf.indexOf(ch.charCodeAt(0), this.pos);
    if (end < 0) this.fail(`missing '${ch}'`);
    const s = this.buf.toString('latin1', this.pos, end);
    this.pos = end + 1;
    return s;
  }

  int(ch) {
    const s = this.readUntil(ch);
    if (!/^-?\d+$/.test(s)) this.fail(`bad integer ${JSON.stringify(s)}`);
    return Number(s);
  }

  str() {
    const len = this.int(':');
    this.expect('"');
    if (this.pos + len > this.buf.length) this.fail('string runs past end');
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    this.expect('"');
    return s;
  }

  value() {
    if (this.pos >= this.buf.length) this.fail('unexpected end');
    const type = String.fromCharCode(this.buf[this.pos]);
    this.pos++;
    if (type === 'N') {
      this.expect(';');
      return null;
    }
    this.expect(':');
    switch (type) {
      case 'i':
        return this.int(';');
      case 'b': {
        const v = this.int(';');
        if (v !== 0 && v !== 1) this.fail('bad boolean');
        return v === 1;
      }
      case 'd': {
        const s = this.readUntil(';');
        if (s === 'INF') return Infinity;
        if (s === '-INF') return -Infinity;
        if (s === 'NAN') return NaN;
        const n = Number(s);
        if (s === '' || Number.isNaN(n)) this.fail(`bad float ${JSON.stringify(s)}`);
        return n;
      }
      case 's': {
        const s = this.str();
        this.expect(';');
        return s;
      }
      case 'a':
        return this.array();
      case 'O':
        return this.object();
      default:
        this.pos--;
        return this.fail(`unsupported type '${type}'`);
    }
  }

  entries(count) {
    this.expect('{');
    const items = [];
    for (let i = 0; i < count; i++) {
      const k = this.value();
      if (typeof k !== 'number' && typeof k !== 'string') this.fail('bad key');
      items.push([k, this.value()]);
    }
    this.expect('}');
    return items;
  }

  array() {
    const items = this.entries(this.int(':'));
    if (items.every(([k], i) => k === i)) return items.map(([, v]) => v);
    return Object.fromEntries(items);
  }

  object() {
    const cls = this.str();
    this.expect(':');
    const items = this.entries(this.int(':'));
    const obj = { __class: cls };
    for (const [k, v] of items) {
      // private "\0Class\0prop" and protected "\0*\0prop" names
      obj[String(k).replace(/^\0[^\0]*\0/, '')] = v;
    }
    return obj;
  }
}
