import { describe, expect, it } from 'vitest';
import { BwVault, type BwRunner } from '../server/secrets-vault-bw.js';

const ORG = '6e5e16f0-920d-4edd-8767-6fa9970785ec';
const FAKE = `FAKE_ONLY_${'ab'.repeat(16)}`;
type Call = { args: string[]; input?: string; session?: string };

/** Simula la CLI `bw` con estado mínimo: login, colecciones e ítems de la organización. */
function fakeBw(options: { status?: 'unauthenticated' | 'locked' | 'unlocked'; lockOnce?: boolean } = {}) {
  let status = options.status ?? 'unauthenticated';
  let lockOnce = options.lockOnce ?? false;
  const calls: Call[] = [];
  const collections = [{ id: 'col-default', name: 'Default collection', organizationId: ORG }];
  const items: Record<string, { id: string; type: number; name: string; notes?: string | null; login?: { password: string | null } | null; organizationId: string; collectionIds: string[]; revisionDate: string }> = {};
  let n = 0;
  const decode = (input?: string) => JSON.parse(Buffer.from(input ?? '', 'base64').toString('utf8'));
  const runner: BwRunner = async (args, env, input) => {
    calls.push({ args, input, session: env.BW_SESSION });
    const [cmd, what, arg] = args;
    if (cmd === 'status') return JSON.stringify({ status });
    if (cmd === 'config') return 'Saved setting `config`.';
    if (cmd === 'login') { status = 'unlocked'; return 'session-login'; }
    if (cmd === 'unlock') { status = 'unlocked'; return 'session-unlock'; }
    if (status !== 'unlocked') throw new Error('Vault is locked.');
    if (lockOnce && cmd !== 'sync') { lockOnce = false; throw new Error('Vault is locked.'); }
    if (cmd === 'sync') return 'Syncing complete.';
    if (cmd === 'list' && what === 'org-collections') return JSON.stringify(collections);
    if (cmd === 'create' && what === 'org-collection') {
      const body = decode(input); const col = { id: `col-${++n}`, name: body.name, organizationId: ORG }; collections.push(col); return JSON.stringify(col);
    }
    if (cmd === 'list' && what === 'items') {
      const col = args[args.indexOf('--collectionid') + 1];
      return JSON.stringify(Object.values(items).filter(i => i.collectionIds.includes(col!)));
    }
    if (cmd === 'create' && what === 'item') {
      const body = decode(input); const item = { ...body, id: `item-${++n}`, revisionDate: '2026-11-11T12:00:00.000Z' }; items[item.id] = item; return JSON.stringify(item);
    }
    if (cmd === 'get' && what === 'item') { const item = items[arg!]; if (!item) throw new Error('Not found.'); return JSON.stringify(item); }
    if (cmd === 'edit' && what === 'item') { items[arg!] = { ...items[arg!]!, ...decode(input) }; return JSON.stringify(items[arg!]); }
    throw new Error(`comando no simulado: ${args.join(' ')}`);
  };
  return { runner, calls, items, collections };
}
const config = { serverUrl: 'https://vault.example', email: 'broker@vault.example', password: 'contraseña-larga-de-prueba', organizationId: ORG, dataDir: '/tmp/bw-test' };

describe('BwVault (conector Vaultwarden por la CLI bw)', () => {
  it('sin sesión: configura servidor, inicia sesión y crea la colección e ítem', async () => {
    const bw = fakeBw();
    const vault = new BwVault(config, bw.runner);
    const ref = await vault.put({ collection: 'prod-erp/dev', name: 'OPENAI_API_KEY' }, FAKE);
    expect(bw.calls.map(c => c.args[0])).toEqual(expect.arrayContaining(['status', 'config', 'login', 'sync', 'create']));
    expect(bw.collections.map(c => c.name)).toContain('prod-erp/dev');
    expect(bw.items[ref]).toMatchObject({ type: 2, name: 'OPENAI_API_KEY', notes: FAKE, organizationId: ORG });
    expect(await vault.get(ref)).toBe(FAKE);
  });

  it('nunca pasa el valor ni la contraseña como argumento de línea de comandos', async () => {
    const bw = fakeBw();
    const vault = new BwVault(config, bw.runner);
    const ref = await vault.put({ collection: 'p/dev', name: 'K' }, FAKE);
    await vault.get(ref);
    const argv = JSON.stringify(bw.calls.map(c => c.args));
    expect(argv).not.toContain(FAKE);
    expect(argv).not.toContain(config.password);
  });

  it('bóveda bloqueada: desbloquea en vez de volver a iniciar sesión', async () => {
    const bw = fakeBw({ status: 'locked' });
    await new BwVault(config, bw.runner).list('p/dev');
    const cmds = bw.calls.map(c => c.args[0]);
    expect(cmds).toContain('unlock');
    expect(cmds).not.toContain('login');
  });

  it('usa la sesión obtenida en las órdenes siguientes', async () => {
    const bw = fakeBw({ status: 'locked' });
    await new BwVault(config, bw.runner).list('p/dev');
    const listCall = bw.calls.find(c => c.args[0] === 'list' && c.args[1] === 'org-collections');
    expect(listCall?.session).toBe('session-unlock');
  });

  it('pegar de nuevo la misma variable actualiza el ítem existente', async () => {
    const bw = fakeBw();
    const vault = new BwVault(config, bw.runner);
    const first = await vault.put({ collection: 'p/dev', name: 'K' }, 'FAKE_ONLY_uno');
    const second = await vault.put({ collection: 'p/dev', name: 'K' }, 'FAKE_ONLY_dos');
    expect(second).toBe(first);
    expect(Object.keys(bw.items)).toHaveLength(1);
    expect(await vault.get(first)).toBe('FAKE_ONLY_dos');
  });

  it('lista metadatos sin valores e ignora colecciones inexistentes', async () => {
    const bw = fakeBw();
    const vault = new BwVault(config, bw.runner);
    await vault.put({ collection: 'p/dev', name: 'K' }, FAKE);
    const items = await vault.list('p/dev');
    expect(items).toEqual([{ itemRef: expect.any(String), name: 'K', updatedAt: '2026-11-11T12:00:00.000Z' }]);
    expect(JSON.stringify(items)).not.toContain(FAKE);
    expect(await vault.list('no-existe/dev')).toEqual([]);
    expect(bw.collections.map(c => c.name)).not.toContain('no-existe/dev');
  });

  it('lee también contraseñas de ítems tipo login creados a mano', async () => {
    const bw = fakeBw({ status: 'unlocked' });
    bw.items['manual'] = { id: 'manual', type: 1, name: 'ML_PASSWORD', login: { password: FAKE }, organizationId: ORG, collectionIds: ['col-default'], revisionDate: '2026-11-10T00:00:00.000Z' };
    expect(await new BwVault(config, bw.runner).get('manual')).toBe(FAKE);
  });

  it('rechaza ítems de fuera de la organización', async () => {
    const bw = fakeBw({ status: 'unlocked' });
    bw.items['ajeno'] = { id: 'ajeno', type: 2, name: 'X', notes: FAKE, organizationId: 'otra-org', collectionIds: [], revisionDate: '2026-11-10T00:00:00.000Z' };
    await expect(new BwVault(config, bw.runner).get('ajeno')).rejects.toThrow(/organización/);
  });

  it('si la bóveda se bloquea entre órdenes, desbloquea y reintenta una vez', async () => {
    const bw = fakeBw({ status: 'unlocked', lockOnce: true });
    await expect(new BwVault(config, bw.runner).list('Default collection')).resolves.toEqual([]);
    // Un desbloqueo al empezar (sin sesión en memoria) y otro tras el bloqueo intermedio.
    expect(bw.calls.filter(c => c.args[0] === 'unlock')).toHaveLength(2);
  });

  it('serializa las órdenes: la CLI comparte un archivo de estado', async () => {
    const bw = fakeBw({ status: 'unlocked' });
    let running = 0, max = 0;
    const slow: BwRunner = async (args, env, input) => { running++; max = Math.max(max, running); await new Promise(r => setTimeout(r, 5)); try { return await bw.runner(args, env, input); } finally { running--; } };
    const vault = new BwVault(config, slow);
    await Promise.all([vault.list('p/a'), vault.list('p/b'), vault.put({ collection: 'p/c', name: 'K' }, FAKE)]);
    expect(max).toBe(1);
  });

  it('los errores no incluyen la salida de la CLI (podría contener datos)', async () => {
    const failing: BwRunner = async () => { throw new Error(`salida con ${FAKE}`); };
    await expect(new BwVault(config, failing).list('p/dev')).rejects.toSatisfy((e: Error) => !e.message.includes(FAKE));
  });
});
