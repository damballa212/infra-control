import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { SecretsError, SecretsService, type SecretsPolicy } from '../server/secrets.js';
import { MemoryVault } from '../server/secrets-vault.js';

const FAKE = `FAKE_ONLY_${'ab'.repeat(16)}`;
const policy: SecretsPolicy = { projects: ['prod-erp'], names: ['OPENAI_API_KEY', 'DATABASE_URL'] };
let now = Date.parse('2026-11-11T12:00:00Z');
let store: Store;
let vault: MemoryVault;
let service: SecretsService;

const input = {
  name: 'OPENAI_API_KEY', project: 'prod-erp', environment: 'dev', machine: 'macbook-air',
  reason: 'pruebas locales', destination: { kind: 'dotenv' as const, path: '.env.local' }
};

beforeEach(() => {
  now = Date.parse('2026-11-11T12:00:00Z');
  store = new Store(':memory:');
  vault = new MemoryVault(() => new Date(now).toISOString());
  service = new SecretsService(store, vault, () => now);
});
afterEach(() => store.close());

describe('crear solicitudes', () => {
  it('registra una solicitud pendiente sin ningún valor', () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    expect(request).toMatchObject({ state: 'pending', agent: 'claude-mac', name: 'OPENAI_API_KEY', project: 'prod-erp' });
    expect(Date.parse(request.expiresAt)).toBe(now + 24 * 3_600_000);
    expect(JSON.stringify(request)).not.toMatch(/value|itemRef/i);
  });
  it('es idempotente por agente y clave', () => {
    const a = service.create('claude-mac', policy, input, 'k1');
    const b = service.create('claude-mac', policy, input, 'k1');
    expect(b.id).toBe(a.id);
    expect(service.create('otro', policy, input, 'k1').id).not.toBe(a.id);
  });
  it('rechaza proyecto o nombre fuera de la política del agente', () => {
    expect(() => service.create('a', policy, { ...input, project: 'otro' }, 'k')).toThrow(SecretsError);
    expect(() => service.create('a', policy, { ...input, name: 'STRIPE_KEY' }, 'k')).toThrow(SecretsError);
  });
  it('el comodín * permite cualquier proyecto pero sigue pendiente de aprobación', () => {
    const request = service.create('claude-ec2', { projects: ['*'] }, { ...input, project: 'cualquier-otro' }, 'k-star');
    expect(request).toMatchObject({ state: 'pending', project: 'cualquier-otro' });
  });
  it('valida nombre, motivo y destino', () => {
    for (const bad of [
      { name: 'bad-name' }, { reason: '' }, { reason: 'x'.repeat(201) },
      { destination: { kind: 'dotenv' as const, path: '../.env' } },
      { destination: { kind: 'dotenv' as const, path: '/etc/passwd' } },
      { destination: { kind: 'dotenv' as const, path: 'config.json' } },
      { destination: { kind: 'dotenv' as const, path: 'a/../.env' } }
    ])
      expect(() => service.create('a', { projects: ['prod-erp'] }, { ...input, ...bad }, 'k')).toThrow(SecretsError);
  });
});

describe('aprobar, denegar y entregar', () => {
  it('pegar un valor lo guarda en la bóveda y lo entrega una sola vez', async () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    const approved = await service.approve(request.id, { mode: 'paste', value: FAKE }, 'once');
    expect(approved.state).toBe('approved');
    expect(JSON.stringify(approved)).not.toContain(FAKE);
    const delivery = await service.claim(request.id, 'claude-mac');
    expect(delivery).toEqual({ name: 'OPENAI_API_KEY', value: FAKE, destination: input.destination });
    await expect(service.claim(request.id, 'claude-mac')).rejects.toMatchObject({ code: 'not_claimable' });
    expect(service.get(request.id)?.state).toBe('delivered');
  });
  it('nada del valor queda en las tablas del panel', async () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    await service.approve(request.id, { mode: 'paste', value: FAKE }, 'once');
    await service.claim(request.id, 'claude-mac');
    const dump = JSON.stringify([
      store.db.prepare('SELECT * FROM secret_requests').all(),
      store.db.prepare('SELECT * FROM secret_audit').all(),
      store.db.prepare('SELECT * FROM secret_grants').all()
    ]);
    expect(dump).not.toContain(FAKE);
  });
  it('solo el agente solicitante puede reclamar y solo si fue aprobada', async () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    await expect(service.claim(request.id, 'claude-mac')).rejects.toMatchObject({ code: 'not_claimable' });
    await service.approve(request.id, { mode: 'paste', value: FAKE }, 'once');
    await expect(service.claim(request.id, 'intruso')).rejects.toMatchObject({ code: 'not_found' });
    expect(service.get(request.id)?.state).toBe('approved');
  });
  it('elegir un ítem existente no vuelve a escribir en la bóveda', async () => {
    const itemRef = await vault.put({ collection: 'prod-erp/dev', name: 'OPENAI_API_KEY' }, FAKE);
    const request = service.create('claude-mac', policy, input, 'k1');
    await service.approve(request.id, { mode: 'existing', itemRef }, 'once');
    expect(vault.putCount).toBe(1);
    expect((await service.claim(request.id, 'claude-mac')).value).toBe(FAKE);
  });
  it('rechaza un ítem que no existe en la colección del proyecto', async () => {
    const other = await vault.put({ collection: 'otro-proyecto/dev', name: 'X' }, FAKE);
    const request = service.create('claude-mac', policy, input, 'k1');
    await expect(service.approve(request.id, { mode: 'existing', itemRef: other }, 'once')).rejects.toMatchObject({ code: 'item_not_found' });
    await expect(service.approve(request.id, { mode: 'existing', itemRef: 'nope' }, 'once')).rejects.toMatchObject({ code: 'item_not_found' });
  });
  it('denegar es terminal', async () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    expect(service.deny(request.id).state).toBe('denied');
    await expect(service.approve(request.id, { mode: 'paste', value: FAKE }, 'once')).rejects.toMatchObject({ code: 'not_pending' });
  });
  it('una solicitud vencida no se aprueba ni se entrega', async () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    now += 25 * 3_600_000;
    await expect(service.approve(request.id, { mode: 'paste', value: FAKE }, 'once')).rejects.toMatchObject({ code: 'not_pending' });
    expect(service.get(request.id)?.state).toBe('expired');
  });
  it('valida el valor pegado', async () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    for (const value of ['', 'a\nb', 'x'.repeat(8193)])
      await expect(service.approve(request.id, { mode: 'paste', value }, 'once')).rejects.toMatchObject({ code: 'invalid_value' });
    expect(service.get(request.id)?.state).toBe('pending');
  });
  it('si la bóveda falla al entregar queda failed y no se reintenta', async () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    await service.approve(request.id, { mode: 'paste', value: FAKE }, 'once');
    vault.failNextGet = true;
    await expect(service.claim(request.id, 'claude-mac')).rejects.toMatchObject({ code: 'vault_unavailable' });
    expect(service.get(request.id)?.state).toBe('failed');
  });
  it('dos entregas simultáneas: solo una recibe el valor', async () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    await service.approve(request.id, { mode: 'paste', value: FAKE }, 'once');
    const results = await Promise.allSettled([service.claim(request.id, 'claude-mac'), service.claim(request.id, 'claude-mac')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('permisos permanentes', () => {
  it('«equipo+proyecto» aprueba solas las siguientes peticiones iguales, con auditoría', async () => {
    const first = service.create('claude-mac', policy, input, 'k1');
    await service.approve(first.id, { mode: 'paste', value: FAKE }, 'machine_project');
    await service.claim(first.id, 'claude-mac');
    const second = service.create('claude-mac', policy, input, 'k2');
    expect(second.state).toBe('approved');
    expect((await service.claim(second.id, 'claude-mac')).value).toBe(FAKE);
    expect(service.audit().some(e => e.event === 'auto_approved' && e.requestId === second.id)).toBe(true);
  });
  it('el permiso no se extiende a otro equipo ni a otro nombre', async () => {
    const first = service.create('claude-mac', policy, input, 'k1');
    await service.approve(first.id, { mode: 'paste', value: FAKE }, 'machine_project');
    expect(service.create('claude-mac', policy, { ...input, machine: 'pc-windows' }, 'k2').state).toBe('pending');
    expect(service.create('claude-mac', policy, { ...input, name: 'DATABASE_URL' }, 'k3').state).toBe('pending');
    expect(service.create('otro-agente', policy, input, 'k4').state).toBe('pending');
  });
  it('revocar un permiso vuelve a exigir aprobación', async () => {
    const first = service.create('claude-mac', policy, input, 'k1');
    await service.approve(first.id, { mode: 'paste', value: FAKE }, 'always');
    const [grant] = service.grants();
    expect(grant).toBeDefined();
    service.revokeGrant(grant!.id);
    expect(service.create('claude-mac', policy, input, 'k2').state).toBe('pending');
  });
  it('«una vez» no crea permiso', async () => {
    const first = service.create('claude-mac', policy, input, 'k1');
    await service.approve(first.id, { mode: 'paste', value: FAKE }, 'once');
    expect(service.grants()).toHaveLength(0);
  });
});

describe('auditoría', () => {
  it('registra cada paso con actor y sin valores', async () => {
    const request = service.create('claude-mac', policy, input, 'k1');
    await service.approve(request.id, { mode: 'paste', value: FAKE }, 'once');
    await service.claim(request.id, 'claude-mac');
    expect(service.audit().map(e => e.event)).toEqual(['delivered', 'approved', 'created']);
    expect(JSON.stringify(service.audit())).not.toContain(FAKE);
  });
});

describe('búsqueda automática en la bóveda (autoDeliver)', () => {
  const auto: SecretsPolicy = { ...policy, autoDeliver: true };
  it('aprueba sola una vez si el nombre existe en la colección del proyecto y no avisa a Admin', async () => {
    const avisos: string[] = [];
    service = new SecretsService(store, vault, () => now, r => avisos.push(r.id));
    await vault.put({ collection: 'prod-erp/dev', name: 'OPENAI_API_KEY' }, FAKE);
    const request = await service.request('claude-mac', auto, input, 'k1');
    expect(request).toMatchObject({ state: 'approved', scope: 'once', auto: true });
    expect(avisos).toEqual([]);
    expect((await service.claim(request.id, 'claude-mac')).value).toBe(FAKE);
    expect(service.grants()).toHaveLength(0);
    expect(service.audit().map(e => e.event)).toEqual(['delivered', 'auto_found', 'created']);
  });
  it('sin autoDeliver la misma situación sigue esperando a Admin', async () => {
    await vault.put({ collection: 'prod-erp/dev', name: 'OPENAI_API_KEY' }, FAKE);
    expect((await service.request('claude-mac', policy, input, 'k1')).state).toBe('pending');
  });
  it('si no existe, o existe en otro proyecto o entorno, queda pendiente y avisa', async () => {
    const avisos: string[] = [];
    service = new SecretsService(store, vault, () => now, r => avisos.push(r.id));
    await vault.put({ collection: 'prod-erp/prod', name: 'OPENAI_API_KEY' }, FAKE);
    await vault.put({ collection: 'otro/dev', name: 'OPENAI_API_KEY' }, FAKE);
    const request = await service.request('claude-mac', auto, input, 'k1');
    expect(request.state).toBe('pending');
    expect(avisos).toEqual([request.id]);
  });
  it('si la bóveda falla al listar, queda pendiente en vez de fallar', async () => {
    const roto = new SecretsService(store, { ...vault, put: vault.put.bind(vault), get: vault.get.bind(vault), list: async () => { throw new Error('caída'); } }, () => now);
    expect((await roto.request('claude-mac', auto, input, 'k1')).state).toBe('pending');
  });
  it('con coincidencias ambiguas no elige: queda pendiente', async () => {
    const doble = new SecretsService(store, { put: vault.put.bind(vault), get: vault.get.bind(vault), list: async () => [
      { itemRef: 'a', name: 'OPENAI_API_KEY', updatedAt: '' }, { itemRef: 'b', name: 'OPENAI_API_KEY', updatedAt: '' }] }, () => now);
    expect((await doble.request('claude-mac', auto, input, 'k1')).state).toBe('pending');
  });
  it('la política sigue mandando: proyecto o variable fuera de ella se rechazan', async () => {
    await vault.put({ collection: 'otro/dev', name: 'OPENAI_API_KEY' }, FAKE);
    await expect(service.request('a', auto, { ...input, project: 'otro' }, 'k')).rejects.toThrow(SecretsError);
    await expect(service.request('a', auto, { ...input, name: 'AWS_SECRET' }, 'k2')).rejects.toThrow(SecretsError);
  });
  it('reintentar con la misma clave devuelve la misma solicitud sin avisar de nuevo', async () => {
    const avisos: string[] = [];
    service = new SecretsService(store, vault, () => now, r => avisos.push(r.id));
    const a = await service.request('claude-mac', auto, input, 'k1');
    const b = await service.request('claude-mac', auto, input, 'k1');
    expect(b.id).toBe(a.id);
    expect(avisos).toHaveLength(1);
  });
  it('available lista solo nombres dentro de la política, nunca valores ni referencias', async () => {
    await vault.put({ collection: 'prod-erp/dev', name: 'OPENAI_API_KEY' }, FAKE);
    await vault.put({ collection: 'prod-erp/dev', name: 'AWS_SECRET' }, FAKE);
    await vault.put({ collection: 'prod-erp/dev', name: 'nota libre' }, FAKE);
    const items = await service.available(policy, 'prod-erp', 'dev');
    expect(items.map(i => i.name)).toEqual(['OPENAI_API_KEY']);
    expect(JSON.stringify(items)).not.toMatch(new RegExp(`${FAKE}|itemRef|item-`));
    await expect(service.available(policy, 'otro')).rejects.toThrow(SecretsError);
  });
});
