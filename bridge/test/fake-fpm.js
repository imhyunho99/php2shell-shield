// A tiny FastCGI responder for tests. respond(params, stdin) returns the raw
// CGI output (headers + body) as a string or Buffer.
import net from 'node:net';

// maxWorkers mimics pm.max_children: a worker owns a connection until it
// closes, and further connections wait unserved.
export function fakeFpm(respond, { maxWorkers = Infinity, delayMs = 0 } = {}) {
  const stats = { connections: 0, requests: 0 };
  const sockets = new Set();
  let busy = 0;
  const waiting = [];
  const server = net.createServer((sock) => {
    stats.connections++;
    sockets.add(sock);
    sock.pause();
    const start = () => {
      busy++;
      sock.resume();
    };
    sock.on('close', () => {
      sockets.delete(sock);
      if (sock.isPaused() && waiting.includes(start)) {
        waiting.splice(waiting.indexOf(start), 1);
        return;
      }
      busy--;
      const next = waiting.shift();
      if (next) next();
    });
    if (busy < maxWorkers) start();
    else waiting.push(start);
    let buf = Buffer.alloc(0);
    let params = Buffer.alloc(0);
    let stdin = Buffer.alloc(0);
    let keep = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const type = buf[1];
        const id = buf.readUInt16BE(2);
        const len = buf.readUInt16BE(4);
        const pad = buf[6];
        if (buf.length < 8 + len + pad) break;
        const body = buf.subarray(8, 8 + len);
        buf = buf.subarray(8 + len + pad);
        if (type === 1) {
          keep = (body[2] & 1) === 1;
          params = Buffer.alloc(0);
          stdin = Buffer.alloc(0);
        } else if (type === 4) {
          params = Buffer.concat([params, body]);
        } else if (type === 5 && len > 0) {
          stdin = Buffer.concat([stdin, body]);
        } else if (type === 5) {
          stats.requests++;
          const reply = () => {
          const out = Buffer.from(respond(decodeParams(params), stdin));
          for (let i = 0; i < out.length; i += 65535) {
            sock.write(record(6, id, out.subarray(i, i + 65535)));
          }
          sock.write(record(6, id, Buffer.alloc(0)));
          sock.write(record(3, id, Buffer.alloc(8)));
          if (!keep) sock.end();
          };
          if (delayMs) setTimeout(reply, delayMs);
          else reply();
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ port: server.address().port, stats, close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(r);
    }) });
  }));
}

function record(type, id, body) {
  const h = Buffer.alloc(8);
  h[0] = 1;
  h[1] = type;
  h.writeUInt16BE(id, 2);
  h.writeUInt16BE(body.length, 4);
  return Buffer.concat([h, body]);
}

function decodeParams(buf) {
  const out = {};
  let i = 0;
  const len = () => {
    if (buf[i] >> 7) {
      const n = buf.readUInt32BE(i) & 0x7fffffff;
      i += 4;
      return n;
    }
    return buf[i++];
  };
  while (i < buf.length) {
    const nl = len();
    const vl = len();
    const name = buf.toString('utf8', i, i + nl);
    i += nl;
    out[name] = buf.toString('utf8', i, i + vl);
    i += vl;
  }
  return out;
}
