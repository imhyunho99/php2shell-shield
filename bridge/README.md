# php-bridge

Move a PHP app to Node one route at a time.

php-bridge puts Node in front of PHP-FPM, replacing nginx or Apache. Routes you write in Node answer in Node. Everything else, whether static files or PHP scripts, is served the way the old server did. Your users keep their PHP login session, because Node can read it. You move routes over at whatever pace suits you, and the stats show what is still running on PHP.

```
browser ──▶ php-bridge (Node) ──┬─▶ your Node routes      (migrated)
                                ├─▶ static files
                                └─▶ PHP-FPM (FastCGI)     (not yet)
```

This is the [strangler fig](https://martinfowler.com/bliki/StranglerFigApplication.html) pattern with the plumbing done: a FastCGI client, nginx-style `try_files`, PHP session decoding, and the PHP2Shell request checks from this repo's [shield](../README.md).

## Quick start

```sh
npm install https://github.com/imhyunho99/php2shell-shield/releases/download/v2.0.0/php-bridge-2.0.0.tgz
```

Write the first route you're moving:

```js
// routes.mjs
export default (bridge) => {
  bridge.get('/api/me', async (req, res) => {
    const session = await req.phpSession(); // the PHP app's $_SESSION
    res.json({ user: session?.user ?? null });
  });
};
```

Run it where nginx used to be:

```sh
npx php-bridge --listen :80 --root /var/www/html --fpm 127.0.0.1:9000 \
  --front-controller index.php --routes ./routes.mjs \
  --session-path /var/lib/php/sessions
```

`/api/me` is now Node, and every other URL still reaches PHP exactly as before.

## As a library

```js
import http from 'node:http';
import { createBridge } from 'php-bridge';

const bridge = createBridge({
  root: '/var/www/html',              // document root on this machine
  fpm: { host: '127.0.0.1', port: 9000 }, // or { path: '/run/php/php8.3-fpm.sock' }
  frontController: 'index.php',       // Laravel, WordPress, Symfony...
  session: { savePath: '/var/lib/php/sessions' },
});

bridge.get('/api/users/:id', async (req, res) => {
  res.json({ id: req.params.id, q: req.query.get('q') });
});

http.createServer(bridge.handler).listen(3000);
```

With Express, mount your migrated routes first and the bridge last. Put body parsers on your routes only: the bridge has to forward the raw body to PHP, and fails with a clear error if something has already read it.

```js
app.use('/api/v2', express.json(), v2Router); // migrated, in Node
app.use(bridge.handler);                      // everything else, to PHP
```

### Options

| Option | Default | |
|---|---|---|
| `root` | required | document root on this machine; static files and script lookups come from here |
| `fpm` | required | `{ host, port }` or `{ path }` (unix socket) |
| `fpmRoot` | `root` | document root as PHP-FPM sees it, e.g. inside a container |
| `frontController` | none | where unknown paths go, like `try_files $uri $uri/ /index.php` |
| `session` | none | `{ savePath, name = 'PHPSESSID', serializeHandler = 'php' }` to enable `req.phpSession()` |
| `maxBodyBytes` | 16 MiB | |
| `guard` | on | PHP2Shell checks; an object overrides limits, `false` turns them off |
| `trustProxy` | `false` | use `X-Forwarded-For` / `X-Forwarded-Proto` |
| `fpmTimeoutMs` | 60000 | |
| `onEvent` | JSON to stderr | receives blocks, FPM errors and PHP stderr |

Routes get `req.params`, `req.query` (URLSearchParams), `req.body` (Buffer), `req.phpSession()` and `res.json(value, status)`. `get`, `post`, `put`, `patch`, `delete` and `all` take `:name` parameters and a trailing `*`.

### What still runs on PHP?

```js
bridge.stats();
// { node: { 'GET /api/me': 812 }, php: { '/index.php': 5120, '/wp-login.php': 33 }, static: 9001 }
```

The CLI serves the same data with `--stats-path /__stats`. Keep that path private, since it lists your scripts. The busiest PHP entries are what to move next.

## What it does for you

- **Front-controller routing**, like `try_files $uri $uri/ /index.php?$args`, plus `index.php`/`index.html` directory indexes and `/script.php/extra` `PATH_INFO`.
- **Static files** with content types and `Last-Modified`. `.php` source is never served as a file. Dotfiles (`.env`, `.git`, `.htaccess`) get 403. `..` traversal, encoded included, gets 404.
- **Correct CGI parameters**: `SCRIPT_FILENAME` mapped to the FPM-side path, `REQUEST_URI`, `QUERY_STRING`, `HTTPS`, `HTTP_*`. It drops the `Proxy` header (httpoxy) and header names containing `_` that could pose as another header.
- **PHP sessions in Node**, read-only, from the `files` handler. It reads the `php` and `php_serialize` formats. PHP strings are counted in bytes, so Korean text decodes correctly. Objects come back as plain data and are never instantiated.
- **PHP2Shell checks** on every request (upload-progress field, multipart amplification, oversized bodies) and leaked session cookies stripped from responses. See the [shield README](../README.md) for what these do and don't cover.
- **One FastCGI connection per request, closed by FPM**, the way nginx does it by default. An earlier keep-alive pool turned out to pin FPM workers and starve other clients. Load tests showed it, so it was removed (see below).

## Tested

- 50+ unit tests: FastCGI framing over record boundaries, more concurrent requests than FPM workers, traversal and dotfiles, session decoding including byte-length strings and objects, guard rules, router.
- e2e in CI against real `php:8.3-fpm`: a legacy app with login, sessions, uploads and a front controller, with one route moved to Node that reads the PHP session.
- **WordPress (`wordpress:php8.3-fpm`) with php-bridge as the only web server**, driven by a real browser: login, classic and async media uploads, REST publishing, pretty permalinks, uploaded images served back, visitor comments. 0 errors.
- Load (wrk, 32 connections, same FPM with `pm.max_children = 5`, Docker Desktop on an M-series Mac):

  | | nginx | php-bridge |
  |---|---|---|
  | WordPress home page | 68.7 req/s | 67.9 req/s |
  | empty PHP script | 16.4k req/s | 4.5k req/s |
  | both at once on one FPM | 30.1 req/s | 29.8 req/s |

  On real pages PHP is the bottleneck and the bridge costs nothing measurable. On trivial scripts Node adds a few milliseconds a request. 64 concurrent connections produced 0 FPM errors.

What load testing caught: a keep-alive pool to FPM looked like an optimization. But FPM gives each connection a worker until it closes, so idle pooled connections pinned every worker and nginx on the same FPM could not get one. With FPM's dynamic process manager, idle workers were also closed under pooled sockets, failing requests that can't be safely retried. The pool is gone and there's a test for both cases.

## Limits

- Responses from PHP are buffered, not streamed. Fine for pages and APIs, not for huge downloads or long-polling (serve those as static files or move them to Node).
- Sessions are read-only from Node and only the `files` save handler is supported (not Redis or Memcached yet).
- PHP writes session files `0600`. Run php-bridge as the PHP-FPM user, or set `session.save_path = "0;0640;/var/lib/php/sessions"` and add php-bridge's user to FPM's group. Otherwise `req.phpSession()` fails with an error saying so.
- No WebSocket proxying to PHP.

## License

MIT
