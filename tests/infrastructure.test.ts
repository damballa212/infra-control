import { describe, expect, it, vi } from 'vitest';
import { DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { InfrastructureAdapter, leaf, UncertainError, type Transport } from '../server/infrastructure.js';
import type { Config, Resource } from '../server/types.js';
const now = Date.parse('2026-10-21T03:00:00Z');
function fixture(options: { state?: string; fails?: boolean; stale?: boolean; missing?: boolean } = {}) {
  let time = now;
  const config: Config = { origin: 'https://test.example', passwordHash: 'test', agentTokens: [], aws: [{ name: 'test', accountId: '123456789012', accessKeyId: 'test', secretAccessKey: 'test', instances: [{ id: 'i-test', region: 'us-east-1', name: 'orchestrator', type: 't4g.large' }] }], coolify: { url: 'http://coolify', token: 'not-output', resources: [{ uuid: 'app-test', name: 'Aplicación', type: 'application' }] }, acs: { url: 'http://acs', deviceId: 'device/test%id' } };
  let powerState = options.state ?? 'running';
  const send = vi.fn(async (command: unknown) => {
    if (options.fails) throw new Error('secret');
    if (command instanceof StartInstancesCommand) { powerState = 'running'; return {}; }
    if (command instanceof StopInstancesCommand) { powerState = 'stopped'; return {}; }
    return { Reservations: [{ Instances: options.missing ? [] : [{ InstanceId: 'i-test', State: { Name: powerState } }] }] };
  });
  const device = () => ({ _lastInform: new Date(options.stale ? time - 600000 : time).toISOString(), InternetGatewayDevice: { DeviceInfo: { ModelName: { _value: 'SR1021D', _timestamp: new Date(time).toISOString() }, SoftwareVersion: { _value: 'RP0102', _timestamp: new Date(time).toISOString() } }, ManagementServer: { PeriodicInformInterval: { _value: 60, _timestamp: new Date(time).toISOString() } } } });
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (options.fails) return new Response('{}', { status: 503 });
    if (String(input).startsWith('http://coolify')) return Response.json([{ uuid: 'app-test', status: 'running:healthy', secret: 'must-not-leak' }]);
    if (String(input).includes('/tasks/?')) return Response.json([]);
    return Response.json(init?.method === 'POST' ? { _id: 'task' } : [device()]);
  });
  const ec2 = vi.fn(() => ({ send }) as unknown as ReturnType<Transport['ec2']>);
  const io: Transport = { ec2, fetch: fetcher as typeof fetch, wait: async ms => { time += ms; }, now: () => time };
  return { adapter: new InfrastructureAdapter(config, io), config, io, send, fetcher, ec2, tick: (ms: number) => { time += ms; } };
}
describe('inventario real y moderación de API', () => {
  it('agrupa EC2, comparte polling entre clientes y no crea CWMP al visualizar', async () => {
    const { adapter, send, fetcher } = fixture();
    const all = await Promise.all(Array.from({ length: 12 }, () => adapter.inventory()));
    expect(send).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    const rows = all[0];
    expect(rows.find(r => r.kind === 'ec2')).toMatchObject({ state: 'running', actions: ['stop', 'refresh'] });
    expect(rows.find(r => r.kind === 'router')).toMatchObject({ state: 'reporting', actions: ['refresh'] });
    expect(rows.filter(r => r.kind === 'computer').every(r => r.state === 'unconfigured' && !r.actions.length)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('must-not-leak');
  });
  it('no confunde proveedores inaccesibles con equipos apagados y enfría errores', async () => {
    const { adapter, send, fetcher } = fixture({ fails: true });
    const rows = await adapter.inventory(); await adapter.inventory();
    expect(send).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(rows.filter(r => r.kind !== 'computer').every(r => r.state === 'unknown' && !r.actions.length)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('secret');
  });
  it('distingue reporte atrasado y ausencia de instancia de apagado', async () => {
    const { adapter } = fixture({ stale: true, missing: true });
    const rows = await adapter.inventory();
    expect(rows.find(r => r.kind === 'router')).toMatchObject({ state: 'stale', actions: [] });
    expect(rows.find(r => r.kind === 'ec2')).toMatchObject({ state: 'unknown', observedAt: null, actions: [] });
  });
  it('respeta Retry-After del proveedor incluso cuando caduca el TTL', async () => {
    const f = fixture();
    const fetcher = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '300' } }));
    const adapter = new InfrastructureAdapter(f.config, { ...f.io, fetch: fetcher });
    await adapter.inventory(); f.tick(61000); await adapter.inventory();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
describe('ejecución y comprobación', () => {
  it('controla únicamente IDs configurados y usa un solo intento en escrituras', async () => {
    const { adapter, ec2, send } = fixture();
    const resource = (await adapter.inventory()).find(r => r.kind === 'ec2')!;
    expect((await adapter.perform(resource, 'stop')).message).toContain('detenida');
    expect((await adapter.perform(resource, 'start')).message).toContain('encendida');
    expect(ec2).toHaveBeenCalledWith(expect.anything(), 'us-east-1', 1);
    expect(send.mock.calls.filter(([command]) => command instanceof StopInstancesCommand)).toHaveLength(1);
    await expect(adapter.perform({ ...resource, id: 'aws:test:i-not-allowed' }, 'stop')).rejects.toThrow('not permitted');
  });
  it('verifica una lectura router sin reiniciar ni forzar conexión entrante y limita nuevas tareas', async () => {
    const { adapter, fetcher } = fixture();
    const router = (await adapter.inventory()).find(r => r.kind === 'router')!;
    expect((await adapter.perform(router, 'refresh')).message).toContain('completó');
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1); expect(String(posts[0][0])).toContain('device%2Ftest%25id/tasks');
    expect(String(posts[0][0])).not.toContain('connection_request');
    expect(JSON.parse(posts[0][1]!.body as string).name).toBe('getParameterValues');
    await expect(adapter.perform(router, 'refresh')).rejects.toThrow('2 minutos');
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('reporta incertidumbre cuando AWS no confirma el resultado y nunca reenvía el apagado', async () => {
    const f = fixture();
    const resource = (await f.adapter.inventory()).find(r => r.kind === 'ec2')!;
    const send = vi.fn(async () => ({ Reservations: [{ Instances: [{ InstanceId: 'i-test', State: { Name: 'running' } }] }] }));
    const adapter = new InfrastructureAdapter(f.config, { ...f.io, ec2: () => ({ send }) as unknown as ReturnType<Transport['ec2']> });
    await expect(adapter.perform(resource, 'stop')).rejects.toBeInstanceOf(UncertainError);
    expect(send.mock.calls).toHaveLength(13);
  });
  it('maneja refresh y comandos no soportados sin habilitar shell', async () => {
    const f = fixture(), rows = await f.adapter.inventory();
    for (const row of rows.filter(r => ['ec2', 'service'].includes(r.kind))) expect((await f.adapter.perform(row, 'refresh')).message).toContain('caché');
    await expect(f.adapter.perform(rows.find(r => r.kind === 'computer')!, 'start')).rejects.toThrow('Unsupported');
  });
  it('maneja fallos de ejecución sin considerar verificado un envío ambiguo', async () => {
    const f = fixture({ fails: true });
    const resource = { id: 'aws:test:i-test', kind: 'ec2' } as Resource;
    await expect(f.adapter.perform(resource, 'stop')).rejects.toBeInstanceOf(UncertainError);
    await expect(f.adapter.perform(resource, 'refresh')).rejects.toThrow('unavailable');
    await expect(f.adapter.perform({ id: 'coolify:app-test', kind: 'service' } as Resource, 'refresh')).rejects.toThrow('unavailable');
  });
  it('conserva incertidumbre si falla una lectura tras encolar o falta firmware reciente', async () => {
    for (const mode of ['network', 'stale-firmware']) {
      const f = fixture(); let posts = 0;
      const adapter = new InfrastructureAdapter(f.config, { ...f.io, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') { posts++; return Response.json({ _id: 'queued' }); }
        if (mode === 'network') throw new Error('private-detail');
        if (String(url).includes('/tasks/?')) return Response.json([]);
        return Response.json([{ InternetGatewayDevice: { DeviceInfo: { ModelName: { _value: 'SR1021D', _timestamp: '2099-01-01' } } } }]);
      }) as typeof fetch });
      await expect(adapter.perform({ id: 'router:fiberhome', kind: 'router' } as Resource, 'refresh')).rejects.toBeInstanceOf(UncertainError);
      expect(posts).toBe(1);
    }
  });
});
it('lee hojas CWMP sin inventar valores ausentes', () => {
  expect(leaf({ a: { b: { _value: 60 } } }, 'a.b')).toBe(60);
  expect(leaf({}, 'a.b')).toBeUndefined();
});
