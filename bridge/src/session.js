// Read-only access to PHP's "files" session store, so Node routes see the
// same logged-in user as the PHP app.

import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeSession } from './unserialize.js';

const VALID_ID = /^[0-9A-Za-z,-]{1,256}$/;

export class SessionReader {
  constructor({ savePath, name = 'PHPSESSID', serializeHandler = 'php' }) {
    this.savePath = savePath;
    this.name = name;
    this.serializeHandler = serializeHandler;
  }

  // read returns the session data for the request's cookie, or null.
  async read(cookieHeader) {
    const id = cookieValue(cookieHeader, this.name);
    if (!id || !VALID_ID.test(id)) return null;
    let raw;
    try {
      raw = await fs.readFile(path.join(this.savePath, `sess_${id}`));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (err.code === 'EACCES') {
        throw new Error(
          `php-bridge: cannot read PHP session files in ${this.savePath} (PHP writes them 0600). ` +
            'Run php-bridge as the PHP-FPM user, or set session.save_path = "0;0640;<dir>" and put php-bridge in that group',
        );
      }
      throw err;
    }
    return decodeSession(raw, this.serializeHandler);
  }
}

function cookieValue(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
