// Minimal method + path router with ":name" parameters and a trailing "*".

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const names = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg === '*') {
          names.push('*');
          return '(.*)';
        }
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern, handler, names, re: new RegExp(`^${source}/?$`) });
  }

  // match returns { handler, params, key } or null. HEAD falls back to GET.
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== 'ALL' && r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => {
        params[n] = safeDecode(m[i + 1]);
      });
      return { handler: r.handler, params, key: `${r.method} ${r.pattern}` };
    }
    return null;
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
