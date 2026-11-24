import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
const exec = promisify(execFile);
export type PcSystem = 'windows' | 'cachyos';
export type PcObservation = { online: boolean; controlled: boolean; os?: PcSystem; bootId?: string; defaultSystem?: PcSystem };
export function pcBanner(): Promise<string | null> {
  return new Promise(resolve => {
    let banner = '';
    const socket = createConnection({ host: '127.0.0.1', port: 17723 });
    const finish = (value: string | null) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => finish(null));
    socket.on('data', data => { banner += data.toString('ascii'); if (banner.includes('\n') || banner.length > 512) finish(/^SSH-2\.0-/.test(banner) ? banner : null); });
    socket.on('error', () => finish(null)); socket.on('end', () => finish(null));
  });
}
export async function pcCommand(os: PcSystem, command: 'status' | 'off' | 'windows' | 'cachyos' | 'default-windows' | 'default-cachyos'): Promise<Record<string, unknown>> {
  const user = os === 'windows' ? (process.env.PC_SSH_USER_WINDOWS ?? 'winuser') : (process.env.PC_SSH_USER_LINUX ?? 'linuxuser');
  const { stdout } = await exec('/usr/bin/ssh', ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', '-o', `HostKeyAlias=infra-pc-${os}`, '-o', 'UserKnownHostsFile=/etc/infra-control-wol/pc_known_hosts', '-i', '/etc/infra-control-wol/pc-key', '-p', '17723', `${user}@127.0.0.1`, command], { timeout: 12000, maxBuffer: 2048 });
  const value = JSON.parse(stdout) as Record<string, unknown>;
  if (command === 'status') {
    if (value.os !== os || value.mac !== (process.env.PC_MAC ?? '02:00:00:00:00:01') || typeof value.bootId !== 'string' || value.bootId.length < 8 || value.bootId.length > 100) throw new Error('PC identity mismatch');
    if(value.defaultSystem!==undefined&&value.defaultSystem!=='windows'&&value.defaultSystem!=='cachyos'&&value.defaultSystem!=='unknown')throw new Error('PC boot default mismatch');
  } else if (command.startsWith('default-')) {
    if (value.accepted !== true || value.applied !== true || value.verified !== true || value.defaultSystem !== command.slice('default-'.length)) throw new Error('Boot preference unacknowledged');
  } else if (value.accepted !== true) throw new Error('Power command unacknowledged');
  return value;
}
export async function pcStatus(osHint?: PcSystem): Promise<PcObservation> {
  if (osHint) {
    try {
      const value = await pcCommand(osHint, 'status');
      return { online: true, controlled: true, os: osHint, bootId: value.bootId as string, ...(value.defaultSystem === 'windows' || value.defaultSystem === 'cachyos' ? { defaultSystem: value.defaultSystem } : {}) };
    } catch {
      // A recent push may race an OS change. The hint selects a pinned identity;
      // it never authorizes a command and does not replace SSH verification.
      return { online: Boolean(await pcBanner()), controlled: false };
    }
  }
  const banner = await pcBanner();
  if (!banner) return { online: false, controlled: false };
  const os = banner.includes('OpenSSH_for_Windows') ? 'windows' : 'cachyos';
  try {
    const value = await pcCommand(os, 'status');
    return { online: true, controlled: true, os, bootId: value.bootId as string, ...(value.defaultSystem==='windows'||value.defaultSystem==='cachyos'?{defaultSystem:value.defaultSystem}:{}) };
  } catch { return { online: true, controlled: false }; }
}
