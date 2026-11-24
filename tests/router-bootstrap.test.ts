import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const identity = '000AC2-SR1021D-87C2E28563AD8A130';
function harness(id = identity) {
  let now = 1000000;
  const state = new Map<string, unknown>([['DeviceID.ID', id]]);
  const writes: string[] = [];
  let commits = 0;
  const declare = (path: string, _read: unknown, update?: { value: unknown }) => {
    if (path === 'Tags.*') return [...state].filter(([p, v]) => p.startsWith('Tags.') && v).map(([path, v]) => ({ path, value: [v] }));
    if (update) { state.set(path, Array.isArray(update.value) ? update.value[0] : update.value); writes.push(path); }
    return { path, value: state.has(path) ? [state.get(path)] : undefined };
  };
  return { state, writes, run(name: string) { vm.runInNewContext(readFileSync(`ops/fiberhome/genieacs-${name}.js`, 'utf8'), { declare, commit() { commits++; }, Date: { now: () => now } }); }, tick(ms: number) { now += ms; }, commits: () => commits };
}
describe('bootstrap CWMP restringido y acotado', () => {
  it('solo opera el CPE autorizado y una vez por sesión; conserva tags ajenos', () => {
    const other = harness('other'); other.run('bootstrap'); expect(other.writes).toHaveLength(0);
    const h = harness(); h.state.set('Tags.Other', true); h.run('bootstrap'); const count = h.writes.length;
    h.run('bootstrap'); expect(h.writes).toHaveLength(count); expect(h.commits()).toBe(1); expect(h.state.get('Tags.Other')).toBe(true);
    h.tick(60000); h.run('bootstrap'); expect([...h.state].filter(([p,v]) => p.startsWith('Tags.InfraTunnelBoot_') && v)).toHaveLength(1);
  });
  it('no pisa un diagnóstico ajeno y deja de consultar si el firmware no completa', () => {
    const h = harness(); h.run('bootstrap'); h.state.set('InternetGatewayDevice.IPPingDiagnostics.Host', 'someone-else'); h.tick(10000); h.run('cleanup');
    expect(h.state.get('InternetGatewayDevice.IPPingDiagnostics.Host')).toBe('someone-else');
    expect(h.state.get('Tags.InfraTunnelCleanupPending')).toBe(false);
    const stuck = harness(); stuck.run('bootstrap'); stuck.tick(181000); stuck.run('cleanup');
    expect(stuck.state.get('Tags.InfraTunnelCleanupPending')).toBe(false);
    const count = stuck.writes.length; stuck.run('cleanup'); expect(stuck.writes).toHaveLength(count);
  });
  it('restaura solo nuestro diagnóstico terminado', () => {
    const h = harness(); h.run('bootstrap'); h.state.set('InternetGatewayDevice.IPPingDiagnostics.DiagnosticsState', 'Complete'); h.tick(10000); h.run('cleanup');
    expect(h.state.get('InternetGatewayDevice.IPPingDiagnostics.Host')).toBe('NULL');
    expect(h.state.get('Tags.InfraTunnelCleanupPending')).toBe(false);
  });
});
