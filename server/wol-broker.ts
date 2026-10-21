import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pcStatus, pcCommand, type PcObservation, type PcSystem } from './pc-control.js';
const exec = promisify(execFile);
export async function routerCommand(command: 'check' | 'wake', execute: typeof exec = exec) {
  const { stdout } = await execute('/usr/bin/ssh', ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/etc/infra-control-wol/router_known_hosts', '-i', '/etc/infra-control-wol/wol-key', '-p', '17722', 'root@127.0.0.1', command], { timeout: 9000, maxBuffer: 4096 });
  const value = JSON.parse(stdout) as { ready?: boolean; sent?: boolean; mac?: string; packets?: number };
  if (command === 'wake' ? value.mac !== '02:00:00:00:00:01' || value.sent !== true || value.packets !== 3 : value.ready !== true) throw new Error('Invalid router acknowledgement');
  return value;
}
export function pcOnline(connect: typeof createConnection = createConnection): Promise<boolean> {
  return new Promise(resolve => {
    let banner = '';
    const socket = connect({ host: '127.0.0.1', port: 17723 });
    const finish = (online: boolean) => { socket.destroy(); resolve(online); };
    socket.setTimeout(2500, () => finish(false));
    socket.on('data', data => { banner += data.toString('ascii'); if (banner.includes('\n') || banner.length > 512) finish(/^SSH-2\.0-/.test(banner)); });
    socket.on('error', () => finish(false)); socket.on('end', () => finish(false));
  });
}
type BrokerDependencies = { routerCommand: typeof routerCommand; pcOnline: () => Promise<boolean>; now: () => number; pcStatus?: (osHint?: PcSystem) => Promise<PcObservation>; pcCommand?: typeof pcCommand };
export function createBroker(deps: BrokerDependencies = { routerCommand, pcOnline, pcStatus, pcCommand, now: Date.now }) {
  let busy = false;
  let lastPowerCommand: number | null = null;
  return createServer(async (req, res) => {
    const reply = (code: number, body: object) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = [...url.searchParams.entries()];
    const osHint = query.length === 1 && query[0]![0] === 'os' && (query[0]![1] === 'windows' || query[0]![1] === 'cachyos') ? query[0]![1] as PcSystem : undefined;
    const validQuery = query.length === 0 || osHint !== undefined;
    if (req.method === 'GET' && url.pathname === '/status' && validQuery) {
      const [router, pc] = await Promise.all([deps.routerCommand('check').then(() => true, () => false), deps.pcStatus ? deps.pcStatus(osHint).catch(() => ({ online: false, controlled: false } as PcObservation)) : deps.pcOnline().then(online => ({ online, controlled: false } as PcObservation))]);
      return reply(200, { ready: router, ...pc, observedAt: new Date(deps.now()).toISOString() });
    }
    if (req.method === 'GET' && req.url === '/router/status') {
      const ready = await deps.routerCommand('check').then(() => true, () => false);
      return reply(200, { ready, observedAt: new Date(deps.now()).toISOString() });
    }
    const target = url.pathname === '/power/off' ? 'off' : url.pathname === '/power/windows' ? 'windows' : url.pathname === '/power/cachyos' ? 'cachyos' : null;
    const defaultSystem = url.pathname === '/boot-default/windows' ? 'windows' : url.pathname === '/boot-default/cachyos' ? 'cachyos' : null;
    if (req.method !== 'POST' || !validQuery || (url.pathname === '/wake' && osHint !== undefined) || (url.pathname !== '/wake' && !target && !defaultSystem)) return reply(404, { error: 'Unsupported operation' });
    const powerCommand=url.pathname==='/wake'||target!==null;
    if (busy || powerCommand && lastPowerCommand !== null && deps.now() - lastPowerCommand < 30000) return reply(429, { error: 'Wait before repeating a power command' });
    busy = true; if(powerCommand)lastPowerCommand = deps.now();
    try {
      if (url.pathname === '/wake') { await deps.routerCommand('wake'); reply(200, { sent: true }); }
      else if (defaultSystem) {
        if (!deps.pcStatus || !deps.pcCommand) return reply(503, { error: 'PC control unavailable' });
        const before = await deps.pcStatus(osHint);
        if (!before.controlled || !before.os || !before.bootId) return reply(409, { error: 'PC identity unavailable' });
        const result = await deps.pcCommand(before.os, `default-${defaultSystem}`);
        if (result.accepted !== true || result.applied !== true || result.verified !== true || result.defaultSystem !== defaultSystem) return reply(502, { error: 'Boot preference was not verified' });
        reply(200, { accepted: true, applied: true, verified: true, defaultSystem, beforeBootId: before.bootId, verifiedAt: new Date(deps.now()).toISOString() });
      }
      else {
        if (!deps.pcStatus || !deps.pcCommand) return reply(503, { error: 'PC control unavailable' });
        const before = await deps.pcStatus(osHint);
        if (!before.controlled || !before.os || !before.bootId) return reply(409, { error: 'PC identity unavailable' });
        if(target===null)return reply(404,{error:'Unsupported operation'});
        // Reiniciar en el mismo sistema es válido: el comando fijo es el mismo y se confirma con un bootId nuevo.
        await deps.pcCommand(before.os as PcSystem, target);
        reply(200, { accepted: true, before, target });
      }
    }
    catch { reply(502, { error: 'Controller acknowledgement unavailable' }); }
    finally { busy = false; }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = '/run/infra-control-wol/wol.sock';
  if (existsSync(path)) unlinkSync(path);
  const server = createBroker();
  server.requestTimeout = 15000; server.headersTimeout = 5000;
  server.listen(path, () => { chmodSync(path, 0o660); console.log('WOL broker ready'); });
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}
