// Generates the credentials the panel needs, without ever putting a secret in a command line.
//
//   echo 'a long password' | npx tsx scripts/make-credentials.ts reader windows cachyos
//
// Prints `passwordHash` for the config, and for every name a fresh random token (shown once: give it to the agent or
// reporter) plus its SHA-256 `hash` (goes into the config). Tokens are never stored in plain text by the panel.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hashPassword, tokenHash } from '../server/auth.js';

const password = readFileSync(0, 'utf8').trim();
if (password.length < 12) {
  console.error('Pipe a password of at least 12 characters on stdin.');
  process.exit(1);
}
const names = process.argv.slice(2);
const tokens = names.map(name => {
  const token = randomBytes(32).toString('base64url');
  return { name, token, hash: tokenHash(token) };
});
console.log(JSON.stringify({ passwordHash: await hashPassword(password), tokens }, null, 2));
