// PHP2Shell (CVE-2026-109618, CVE-2026-109619) request and response checks,
// ported from the Go shield. They narrow the published paths; upgrading PHP
// is the only complete fix.

export const DEFAULTS = {
  maxParts: 1000,
  maxPartHeaders: 8,
  maxPartHeaderBytes: 4096,
  maxNesting: 8,
  blockMultipart: false,
  progressFields: ['PHP_SESSION_UPLOAD_PROGRESS'],
  sessionCookies: ['PHPSESSID'],
};

// PHP session IDs use [0-9a-zA-Z,-] and are at most 256 chars. A leaked heap
// arrives URL-encoded, so it shows up as '%' and other bytes.
const VALID_SESSION_ID = /^[0-9A-Za-z,-]{0,256}$/;

const deny = (status, rule, detail) => ({ status, rule, detail });

// inspectRequest returns null to let the request through, or
// { status, rule, detail } to refuse it. headers use lowercase names.
export function inspectRequest(headers, body, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ct = headers['content-type'];
  if (Array.isArray(ct)) return deny(400, 'malformed-multipart', 'multiple content-type headers');
  if (!ct || !/multipart/i.test(ct)) return null;
  if (o.blockMultipart) return deny(415, 'multipart-blocked', 'multipart disabled');

  // Byte search first, so a parser differential cannot hide the field.
  const raw = body.toString('latin1').toLowerCase();
  for (const f of o.progressFields) {
    if (raw.includes(f.toLowerCase())) return deny(403, 'upload-progress-field', `field ${f}`);
  }

  const m = /^\s*multipart\/[^;\s]+\s*;.*?\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
  if (!m) return deny(400, 'malformed-multipart', `unparseable content-type ${ct}`);
  return inspectParts(body, Buffer.from('--' + (m[1] ?? m[2])), o);
}

// inspectParts walks the multipart framing. Anything it cannot follow is
// refused rather than passed on for PHP to interpret differently.
function inspectParts(body, delim, o) {
  const CRLF = Buffer.from('\r\n');
  const bad = (detail) => deny(400, 'malformed-multipart', detail);
  if (!body.subarray(0, delim.length).equals(delim)) return bad('body does not start with boundary');
  let pos = delim.length;
  if (!body.subarray(pos, pos + 2).equals(CRLF)) return bad('no CRLF after first boundary');
  pos += 2;

  const next = Buffer.concat([CRLF, delim]);
  for (let parts = 1; ; parts++) {
    if (parts > o.maxParts) return deny(413, 'too-many-parts', `more than ${o.maxParts} parts`);

    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) return bad(`part ${parts} has no header end`);
    const lines = body.toString('utf8', pos, headEnd).split('\r\n');
    let size = 0;
    let name = '';
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i <= 0) return bad(`part ${parts} has a bad header line`);
      size += line.length;
      if (/^content-disposition$/i.test(line.slice(0, i).trim())) {
        name = /\bname="([^"]*)"|\bname=([^;\s]+)/i.exec(line)?.slice(1).find((x) => x !== undefined) ?? '';
      }
    }
    if (lines.length > o.maxPartHeaders || size > o.maxPartHeaderBytes) {
      return deny(431, 'part-headers', `part ${parts} has ${lines.length} headers, ${size} bytes`);
    }
    const depth = (name.match(/\[/g) ?? []).length;
    if (depth > o.maxNesting) return deny(400, 'field-nesting', `field nested ${depth} deep`);

    const end = body.indexOf(next, headEnd + 4);
    if (end < 0) return bad(`part ${parts} is not terminated`);
    pos = end + next.length;
    const tail = body.subarray(pos, pos + 2).toString('latin1');
    if (tail === '--') {
      const rest = body.subarray(pos + 2).toString('latin1');
      return rest === '' || rest === '\r\n' ? null : bad('data after closing boundary');
    }
    if (tail !== '\r\n') return bad('bad boundary line');
    pos += 2;
  }
}

// scrubSetCookies removes session cookies whose value is not a valid PHP
// session id: that is the channel PHP2Shell uses to leak worker memory.
export function scrubSetCookies(setCookies, opts = {}) {
  const names = (opts.sessionCookies ?? DEFAULTS.sessionCookies).map((n) => n.toLowerCase());
  const cookies = [];
  const leaks = [];
  for (const c of setCookies) {
    const pair = c.split(';', 1)[0];
    const eq = pair.indexOf('=');
    const name = (eq < 0 ? pair : pair.slice(0, eq)).trim();
    const value = eq < 0 ? '' : pair.slice(eq + 1).trim();
    if (names.includes(name.toLowerCase()) && !VALID_SESSION_ID.test(value)) {
      leaks.push({ name, length: value.length });
      continue;
    }
    cookies.push(c);
  }
  return { cookies, leaks };
}
