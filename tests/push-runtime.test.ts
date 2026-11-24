import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// El transporte real nunca se ejercita con mocks: este test carga el JS compilado en Node ESM puro,
// que es como corre en producción, y comprueba que la librería de push quedó accesible.
describe.skipIf(!existsSync('dist/server/push.js'))('web-push en el runtime compilado', () => {
  it('expone sendNotification al cargarse como ESM puro', () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      "const m=await import('./dist/server/push.js');console.log(typeof m.webPush.sendNotification)"], { encoding: 'utf8' });
    expect(out.trim()).toBe('function');
  });
});
