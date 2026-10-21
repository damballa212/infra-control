import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { socketCall } from '../server/desktop.js';
describe('transporte real Unix privado', () => {
 it('valida HTTP/JSON y corta respuestas excesivas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infra-'));
  const path = join(dir, 'w.sock');
  const server = createServer((req, res) => {
   if (req.url === '/bad-status') { res.writeHead(502); return res.end('{}'); }
   if (req.url === '/bad-json') return res.end('broken');
   if (req.url === '/large') return res.end('x'.repeat(5000));
   res.end(JSON.stringify({ sent: true }));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
   const call = socketCall(path);
   expect(await call('POST','/wake')).toEqual({ sent: true });
   await expect(call('GET','/bad-status')).rejects.toThrow('unavailable');
   await expect(call('GET','/bad-json')).rejects.toThrow('Invalid');
   await expect(call('GET','/large')).rejects.toThrow('large');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir,{recursive:true,force:true}); }
 });
});
