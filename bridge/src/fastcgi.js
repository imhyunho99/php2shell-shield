// FastCGI client for PHP-FPM.
//
// Every request gets its own connection and PHP-FPM closes it, the way nginx
// talks to FPM by default. Because FPM closes first, TIME_WAIT lands on the
// FPM side and this process does not run out of ephemeral ports.
//
// There is deliberately no keep-alive pool. FPM dedicates a worker to a
// connection until it closes, so idle pooled connections pin workers and
// starve everyone else, and FPM's process manager closes idle workers under
// a pooled socket, which fails requests that cannot safely be retried.

import net from 'node:net';

const VERSION = 1;
const BEGIN_REQUEST = 1;
const END_REQUEST = 3;
const PARAMS = 4;
const STDIN = 5;
const STDOUT = 6;
const STDERR = 7;
const RESPONDER = 1;
const MAX_RECORD = 65535;
const REQUEST_ID = 1; // one request at a time per connection

export class FastCGIClient {
  // target: { host, port } or { path } (unix socket)
  constructor({ host, port, path, timeoutMs = 60_000 } = {}) {
    this.connectOpts = path ? { path } : { host, port };
    this.timeoutMs = timeoutMs ?? 60_000;
    this.open = new Set();
  }

  async request(params, body = Buffer.alloc(0)) {
    const sock = await this.connect();
    try {
      return await this.exchange(sock, params, body);
    } catch (err) {
      sock.destroy();
      throw err;
    } finally {
      // FPM closes after END_REQUEST; destroy only if it lingers, so the
      // close (and TIME_WAIT) stays on the FPM side.
      setTimeout(() => sock.destroy(), 5000).unref();
    }
  }

  close() {
    for (const s of this.open) s.destroy();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.connectOpts);
      sock.once('connect', () => {
        sock.removeListener('error', reject);
        sock.setNoDelay(true);
        this.open.add(sock);
        sock.on('close', () => this.open.delete(sock));
        sock.on('error', () => {});
        resolve(sock);
      });
      sock.once('error', reject);
    });
  }

  exchange(sock, params, body) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const stdout = [];
      const stderr = [];
      let settled = false;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.removeListener('data', onData);
        sock.removeListener('close', onClose);
        sock.removeListener('error', onError);
        if (err) reject(err);
        else resolve(value);
      };
      const onError = (err) => finish(err);
      const onClose = () => finish(new Error('fastcgi: connection closed before response ended'));
      const onData = (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (buf.length >= 8) {
          const type = buf[1];
          const len = buf.readUInt16BE(4);
          const pad = buf[6];
          if (buf.length < 8 + len + pad) return;
          const content = buf.subarray(8, 8 + len);
          buf = buf.subarray(8 + len + pad);
          if (type === STDOUT) stdout.push(content);
          else if (type === STDERR) stderr.push(content);
          else if (type === END_REQUEST) {
            try {
              const res = parseCgiOutput(Buffer.concat(stdout));
              res.stderr = Buffer.concat(stderr).toString('utf8');
              finish(null, res);
            } catch (err) {
              finish(err);
            }
            return;
          }
        }
      };
      const timer = setTimeout(
        () => finish(new Error(`fastcgi: timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );

      sock.on('data', onData);
      sock.once('close', onClose);
      sock.on('error', onError);

      const begin = Buffer.alloc(8);
      begin.writeUInt16BE(RESPONDER, 0);
      begin[2] = 0; // no FCGI_KEEP_CONN: FPM closes the connection
      const chunks = [record(BEGIN_REQUEST, begin)];
      chunks.push(...stream(PARAMS, encodeParams(params)));
      chunks.push(...stream(STDIN, body));
      sock.write(Buffer.concat(chunks));
    });
  }
}

function record(type, content) {
  const pad = (8 - (content.length % 8)) % 8;
  const h = Buffer.alloc(8);
  h[0] = VERSION;
  h[1] = type;
  h.writeUInt16BE(REQUEST_ID, 2);
  h.writeUInt16BE(content.length, 4);
  h[6] = pad;
  return Buffer.concat([h, content, Buffer.alloc(pad)]);
}

// stream splits data into records and ends with the empty record.
function stream(type, data) {
  const out = [];
  for (let i = 0; i < data.length; i += MAX_RECORD) {
    out.push(record(type, data.subarray(i, i + MAX_RECORD)));
  }
  out.push(record(type, Buffer.alloc(0)));
  return out;
}

function encodeLength(n) {
  if (n < 128) return Buffer.from([n]);
  const b = Buffer.alloc(4);
  b.writeUInt32BE((n | 0x80000000) >>> 0);
  return b;
}

function encodeParams(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const name = Buffer.from(String(k));
    const value = Buffer.from(String(v));
    parts.push(encodeLength(name.length), encodeLength(value.length), name, value);
  }
  return Buffer.concat(parts);
}

// parseCgiOutput splits PHP's CGI output into status, headers and body.
export function parseCgiOutput(out) {
  let end = out.indexOf('\r\n\r\n');
  let sepLen = 4;
  const lf = out.indexOf('\n\n');
  if (lf >= 0 && (end < 0 || lf < end)) {
    end = lf;
    sepLen = 2;
  }
  const head = end >= 0 ? out.toString('latin1', 0, end) : '';
  const body = end >= 0 ? out.subarray(end + sepLen) : out;

  let status = 200;
  const headers = [];
  let sawLocation = false;
  let sawStatus = false;
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (name.toLowerCase() === 'status') {
      const code = parseInt(value, 10);
      if (code >= 100 && code <= 599) status = code;
      sawStatus = true;
      continue;
    }
    if (name.toLowerCase() === 'location') sawLocation = true;
    headers.push([name, value]);
  }
  if (sawLocation && !sawStatus) status = 302;
  return { status, headers, body };
}
