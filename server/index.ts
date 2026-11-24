import { readFileSync, mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { parseConfig } from './config.js';
import { BwVault } from './secrets-vault-bw.js';
import { BwServeVault } from './secrets-vault-bw-serve.js';
const config = parseConfig(JSON.parse(readFileSync(process.env.CONFIG_PATH ?? '/run/secrets/config.json', 'utf8')) as unknown);
const data = process.env.DATA_DIR ?? '/data';
mkdirSync(data, { recursive: true });
let vault: BwVault | BwServeVault | undefined;
if (config.secretsVault) {
  const dataDir = `${data}/bw`;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const { kind: _kind, ...settings } = config.secretsVault;
  const bwPath = process.env.BW_PATH ?? 'bw';
  // BW_MODE=cli vuelve al conector anterior (una CLI por orden) sin cambiar la imagen.
  vault = process.env.BW_MODE === 'cli'
    ? new BwVault({ ...settings, dataDir, bwPath })
    : new BwServeVault({ ...settings, dataDir, bwPath, servePort: Number(process.env.BW_SERVE_PORT ?? 8087) });
  vault.warmUp().then(() => console.log('Bóveda de secretos lista'), () => console.error('Bóveda de secretos no disponible; se reintentará al usarla'));
}
const app = createApp(config, `${data}/infra.sqlite`, undefined, process.env.WEB_ROOT, undefined, vault);
const server = app.listen(Number(process.env.PORT ?? 17600), '0.0.0.0', () => console.log('Infra Control ready'));
function shutdown() { app.locals.closeStreams(); server.close(() => { app.locals.close(); void (vault instanceof BwServeVault ? vault.close() : Promise.resolve()).finally(() => process.exit(0)); }); setTimeout(() => process.exit(1), 15000).unref(); }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
