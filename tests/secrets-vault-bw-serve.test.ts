import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BwServeVault, type ServeHandle } from '../server/secrets-vault-bw-serve.js';
import type { BwRunner } from '../server/secrets-vault-bw.js';

const ORG = '6e5e16f0-920d-4edd-8767-6fa9970785ec';
const FAKE = `FAKE_ONLY_${'ab'.repeat(16)}`;
const config = { serverUrl: 'https://vault.example', email: 'b@vault.example', password: 'contraseña-larga-de-prueba', organizationId: ORG, dataDir: '/tmp/bw-serve-test', indexRefreshMs: 3_600_000 };

/** `bw serve` simulado: mismo formato { success, data } y estado en memoria. */
function fakeServe() {
  const collections: { id: string; name: string; organizationId: string }[] = [];
  const items: Record<string, any> = {};
  const hits: string[] = [];
  let n = 0, launches = 0, failNextPost = false;
  const servers: Server[] = [];
  const handler = (method: string, url: URL, body: any): { code: number; data?: unknown } => {
    const path = url.pathname;
    hits.push(`${method} ${path}`);
    if (path === '/status') return { code: 200, data: { object: 'template', template: { status: 'unlocked' } } };
    if (path === '/sync') return { code: 200, data: { object: 'message' } };
    if (path === '/list/object/org-collections') return { code: 200, data: { object: 'list', data: collections } };
    if (path === '/list/object/items') {
      const col = url.searchParams.get('collectionId');
      return { code: 200, data: { object: 'list', data: Object.values(items).filter(i => !col || i.collectionIds.includes(col)) } };
    }
    if (method === 'POST' && path === '/object/item') {
      if (failNextPost) { failNextPost = false; return { code: 500 }; }
      const item = { ...body, id: `item-${++n}`, revisionDate: '2026-11-24T12:00:00.000Z' }; items[item.id] = item; return { code: 200, data: item };
    }
    const m = /^\/object\/item\/(.+)$/.exec(path);
    if (m) {
      const item = items[decodeURIComponent(m[1]!)];
      if (!item) return { code: 404 };
      if (method === 'PUT') { items[item.id] = { ...item, ...body }; return { code: 200, data: items[item.id] }; }
      return { code: 200, data: item };
    }
    return { code: 404 };
  };
  const launcher = async (): Promise<ServeHandle> => {
    launches++;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const out = handler(req.method!, new URL(req.url!, 'http://x'), raw ? JSON.parse(raw) : undefined);
        res.statusCode = out.code; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out.code === 200 ? { success: true, data: out.data } : { success: false, message: `secreto ${FAKE}` }));
      });
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    let done!: () => void;
    const exited = new Promise<void>(r => { done = r; });
    return { port: (server.address() as AddressInfo).port, exited, stop: async () => { server.close(); server.closeAllConnections(); done(); } };
  };
  const cli: string[][] = [];
  const runner: BwRunner = async (args, _env, input) => {
    cli.push(args);
    if (args[0] === 'status') return JSON.stringify({ status: 'unauthenticated' });
    if (args[0] === 'config') return 'ok';
    if (args[0] === 'login') return 'session-1';
    if (args[0] === 'create' && args[1] === 'org-collection') {
      const body = JSON.parse(Buffer.from(input!, 'base64').toString());
      const col = { id: `col-${++n}`, name: body.name, organizationId: ORG }; collections.push(col); return JSON.stringify(col);
    }
    throw new Error(`CLI no esperada: ${args.join(' ')}`);
  };
  return { launcher, runner, hits, cli, items, collections, launches: () => launches, failNextPost: () => { failNextPost = true; }, killAll: () => servers.forEach(s => { s.close(); s.closeAllConnections(); }) };
}

const vaults: BwServeVault[] = [];
afterEach(async () => { await Promise.all(vaults.splice(0).map(v => v.close())); });
const make = (f: ReturnType<typeof fakeServe>) => { const v = new BwServeVault(config, { runner: f.runner, launcher: f.launcher }); vaults.push(v); return v; };

describe('BwServeVault (conector por bw serve)', () => {
  it('crea colección por CLI, escribe por HTTP, lee y actualiza sin duplicar', async () => {
    const f = fakeServe(); const vault = make(f);
    const ref = await vault.put({ collection: 'p/dev', name: 'K' }, FAKE);
    expect(f.cli.filter(a => a[0] === 'create')).toHaveLength(1);
    expect(f.items[ref]).toMatchObject({ type: 2, name: 'K', notes: FAKE, organizationId: ORG });
    expect(await vault.get(ref)).toBe(FAKE);
    expect(await vault.put({ collection: 'p/dev', name: 'K' }, 'FAKE_ONLY_dos')).toBe(ref);
    expect(Object.keys(f.items)).toHaveLength(1);
    expect(await vault.get(ref)).toBe('FAKE_ONLY_dos');
  });

  it('nunca pasa el valor ni la contraseña como argumento', async () => {
    const f = fakeServe(); const vault = make(f);
    await vault.put({ collection: 'p/dev', name: 'K' }, FAKE);
    const argv = JSON.stringify(f.cli);
    expect(argv).not.toContain(FAKE); expect(argv).not.toContain(config.password);
  });

  it('list usa el índice: tras la carga no vuelve a llamar a la bóveda y no expone valores', async () => {
    const f = fakeServe(); const vault = make(f);
    await vault.put({ collection: 'p/dev', name: 'K' }, FAKE);
    await vault.warmUp();
    const before = f.hits.length;
    const items = await vault.list('p/dev');
    await vault.list('p/dev');
    expect(f.hits.length).toBe(before);
    expect(items).toEqual([{ itemRef: expect.any(String), name: 'K', updatedAt: '2026-11-24T12:00:00.000Z' }]);
    expect(JSON.stringify(items)).not.toContain(FAKE);
    expect(await vault.list('no-existe/dev')).toEqual([]);
  });

  it('cada carga del índice sincroniza primero con el servidor (ve ítems creados por otros)', async () => {
    const f = fakeServe(); const vault = make(f);
    await vault.warmUp();
    const first = f.hits.indexOf('POST /sync');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(f.hits.indexOf('GET /list/object/items'));
  });

  it('antes de escribir sincroniza solo si la última sincronización es vieja (30 s)', async () => {
    const f = fakeServe(); let now = 1_000_000;
    const vault = new BwServeVault(config, { runner: f.runner, launcher: f.launcher, now: () => now }); vaults.push(vault);
    await vault.warmUp();
    await vault.put({ collection: 'p/dev', name: 'K3' }, FAKE); // crea la colección (y sincroniza)
    await new Promise(resolve => setTimeout(resolve, 50)); // deja terminar la recarga de fondo
    f.hits.length = 0;
    await vault.put({ collection: 'p/dev', name: 'K3' }, FAKE);
    expect(f.hits).not.toContain('POST /sync');
    now += 31_000; f.hits.length = 0;
    await vault.put({ collection: 'p/dev', name: 'K3' }, FAKE);
    expect(f.hits.indexOf('POST /sync')).toBeGreaterThanOrEqual(0);
    expect(f.hits.indexOf('POST /sync')).toBeLessThan(f.hits.findIndex(h => h.startsWith('PUT /object/item/')));
  });

  it('tras escribir, el índice ya ve el ítem nuevo', async () => {
    const f = fakeServe(); const vault = make(f);
    await vault.warmUp();
    await vault.put({ collection: 'p/dev', name: 'K2' }, FAKE);
    expect((await vault.list('p/dev')).map(i => i.name)).toEqual(['K2']);
  });

  it('una escritura fallida no se reintenta y falla cerrada sin filtrar el valor', async () => {
    const f = fakeServe(); const vault = make(f);
    await vault.put({ collection: 'p/dev', name: 'A' }, FAKE);
    f.failNextPost();
    const error = await vault.put({ collection: 'p/dev', name: 'B' }, FAKE).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(FAKE);
    expect(f.hits.filter(h => h === 'POST /object/item')).toHaveLength(2);
    expect(Object.keys(f.items)).toHaveLength(1);
  });

  it('rechaza ítems de otra organización o sin valor, e ítems inexistentes', async () => {
    const f = fakeServe(); const vault = make(f);
    await vault.warmUp();
    f.items.x = { id: 'x', type: 2, name: 'X', notes: FAKE, organizationId: 'otra', collectionIds: [] };
    f.items.y = { id: 'y', type: 2, name: 'Y', notes: '', organizationId: ORG, collectionIds: [] };
    await expect(vault.get('x')).rejects.toThrow(/organización/);
    await expect(vault.get('y')).rejects.toThrow(/valor/);
    await expect(vault.get('nope')).rejects.toThrow();
  });

  it('si bw serve muere, se reinicia y la lectura siguiente funciona', async () => {
    const f = fakeServe(); const vault = make(f);
    const ref = await vault.put({ collection: 'p/dev', name: 'K' }, FAKE);
    f.killAll();
    expect(await vault.get(ref)).toBe(FAKE);
    expect(f.launches()).toBeGreaterThanOrEqual(2);
  });

  it('close detiene el proceso', async () => {
    const f = fakeServe(); const vault = make(f);
    await vault.warmUp();
    await vault.close();
    await expect(vault.get('x')).rejects.toThrow();
  });
});
