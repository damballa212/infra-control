import { readFileSync, mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import type { Config } from './types.js';
const config = JSON.parse(readFileSync(process.env.CONFIG_PATH ?? '/run/secrets/config.json', 'utf8')) as Config;
if (!config.origin?.startsWith('https://') || !config.passwordHash || !Array.isArray(config.agentTokens)) throw new Error('Invalid server configuration');
const data = process.env.DATA_DIR ?? '/data';
mkdirSync(data, { recursive: true });
const app = createApp(config, `${data}/infra.sqlite`, undefined, process.env.WEB_ROOT);
const server = app.listen(Number(process.env.PORT ?? 17600), '0.0.0.0', () => console.log('Infra Control ready'));
function shutdown() { app.locals.closeStreams(); server.close(() => { app.locals.close(); process.exit(0); }); setTimeout(() => process.exit(1), 15000).unref(); }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
