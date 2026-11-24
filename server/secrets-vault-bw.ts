import { execFile } from 'node:child_process';
import type { VaultAdapter, VaultItem, VaultTarget } from './secrets-vault.js';

/**
 * Conector con Vaultwarden mediante la CLI oficial `bw`, que hace todo el cifrado del cliente Bitwarden.
 * La cuenta de servicio es dueña de una organización propia («Agentes»); cada `proyecto/entorno` es una
 * colección. Los valores viajan solo por stdin o por la salida de `bw`, nunca como argumentos de proceso.
 */
export type BwVaultConfig = {
  serverUrl: string;
  email: string;
  password: string;
  organizationId: string;
  /** Directorio escribible y persistente para el estado de la CLI (cifrado por Bitwarden). */
  dataDir: string;
  bwPath?: string;
  timeoutMs?: number;
};
export type BwRunner = (args: string[], env: Record<string, string>, input?: string) => Promise<string>;

export type BwStatus = { status: 'unauthenticated' | 'locked' | 'unlocked' };
export type BwCollection = { id: string; name: string; organizationId: string };
export type BwItem = {
  id: string; type: number; name: string; notes?: string | null; login?: { password?: string | null } | null;
  organizationId: string | null; collectionIds: string[]; revisionDate: string;
};

/** Error con mensaje apto para mostrar; cualquier otro se reduce a un mensaje genérico. */
export class VaultRejected extends Error {}

const SYNC_INTERVAL_MS = 30_000;
export const SECURE_NOTE = 2;
export const LOGIN = 1;

/** Ejecuta `bw` sin shell, con entorno mínimo y límite de tiempo. El error no incluye la salida. */
export function execFileRunner(bwPath: string, timeoutMs: number): BwRunner {
  return (args, env, input) => new Promise((resolve, reject) => {
    const child = execFile(bwPath, args, { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error(`bw ${args[0]} falló`)); return; }
      resolve(stdout.trim());
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

export const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

/** Entorno mínimo para la CLI; la contraseña solo viaja por variable de entorno cuando hace falta iniciar o desbloquear. */
export function bwEnv(config: BwVaultConfig, session: string | null, withPassword = false): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: config.dataDir,
    BITWARDENCLI_APPDATA_DIR: config.dataDir,
    BW_NOINTERACTION: 'true',
    NODE_ENV: 'production',
    ...(session ? { BW_SESSION: session } : {}),
    ...(withPassword ? { BW_PASSWORD: config.password } : {})
  };
}

/** Inicia sesión (primera vez) o desbloquea y devuelve la clave de sesión. */
export async function openSession(run: BwRunner, config: BwVaultConfig): Promise<string> {
  const { status } = JSON.parse(await run(['status'], bwEnv(config, null))) as BwStatus;
  if (status === 'unauthenticated') {
    await run(['config', 'server', config.serverUrl], bwEnv(config, null));
    return run(['login', config.email, '--passwordenv', 'BW_PASSWORD', '--raw'], bwEnv(config, null, true));
  }
  return run(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], bwEnv(config, null, true));
}

export class BwVault implements VaultAdapter {
  private queue: Promise<unknown> = Promise.resolve();
  private session: string | null = null;
  private lastSync = 0;
  private collections = new Map<string, string>();
  private readonly run: BwRunner;

  constructor(private readonly config: BwVaultConfig, runner?: BwRunner, private readonly now: () => number = Date.now) {
    this.run = runner ?? execFileRunner(config.bwPath ?? 'bw', config.timeoutMs ?? 60_000);
  }

  put(target: VaultTarget, value: string): Promise<string> {
    return this.serial(async () => {
      await this.sync();
      const collectionId = await this.collectionId(target.collection, true);
      const items = await this.itemsIn(collectionId!);
      const existing = items.find(item => item.name === target.name && item.type === SECURE_NOTE);
      if (existing) {
        const full = JSON.parse(await this.bw(['get', 'item', existing.id])) as BwItem;
        await this.bw(['edit', 'item', existing.id], encode({ ...full, notes: value }));
        return existing.id;
      }
      const created = JSON.parse(await this.bw(['create', 'item'], encode({
        type: SECURE_NOTE, secureNote: { type: 0 }, name: target.name, notes: value, organizationId: this.config.organizationId,
        collectionIds: [collectionId], favorite: false, fields: [], login: null, card: null, identity: null, reprompt: 0
      }))) as BwItem;
      return created.id;
    });
  }

  get(itemRef: string): Promise<string> {
    return this.serial(async () => {
      let item: BwItem;
      try { item = JSON.parse(await this.bw(['get', 'item', itemRef])) as BwItem; }
      catch {
        await this.sync(true);
        item = JSON.parse(await this.bw(['get', 'item', itemRef])) as BwItem;
      }
      if (item.organizationId !== this.config.organizationId) throw new VaultRejected('El ítem no pertenece a la organización de agentes.');
      const value = item.type === LOGIN ? item.login?.password : item.notes;
      if (typeof value !== 'string' || value.length === 0) throw new VaultRejected('El ítem no tiene valor.');
      return value;
    });
  }

  list(collection: string): Promise<VaultItem[]> {
    return this.serial(async () => {
      await this.sync();
      const collectionId = await this.collectionId(collection, false);
      if (!collectionId) return [];
      return (await this.itemsIn(collectionId))
        .filter(item => item.type === SECURE_NOTE || item.type === LOGIN)
        .map(item => ({ itemRef: item.id, name: item.name, updatedAt: item.revisionDate }));
    });
  }

  /** Abre sesión y sincroniza por adelantado para que la primera aprobación no pague el login. */
  warmUp(): Promise<void> {
    return this.serial(async () => { await this.ensureSession(); await this.sync(true); });
  }

  /** Una orden a la vez: la CLI guarda su estado en un único archivo. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next.catch((error: unknown) => { throw error instanceof VaultRejected ? error : new Error('La bóveda no completó la operación.'); });
  }

  private env(): Record<string, string> { return bwEnv(this.config, this.session); }

  private async ensureSession(): Promise<void> {
    if (this.session) return;
    this.session = await openSession(this.run, this.config);
    this.lastSync = 0;
  }

  /** Ejecuta con sesión; si la bóveda se bloqueó, desbloquea y reintenta una sola vez. */
  private async bw(args: string[], input?: string): Promise<string> {
    await this.ensureSession();
    try { return await this.run(args, this.env(), input); }
    catch {
      this.session = null;
      await this.ensureSession();
      return this.run(args, this.env(), input);
    }
  }

  private async sync(force = false): Promise<void> {
    if (!force && this.now() - this.lastSync < SYNC_INTERVAL_MS) return;
    await this.bw(['sync']);
    this.lastSync = this.now();
    this.collections.clear();
  }

  private async collectionId(name: string, create: boolean): Promise<string | undefined> {
    const cached = this.collections.get(name);
    if (cached) return cached;
    const list = JSON.parse(await this.bw(['list', 'org-collections', '--organizationid', this.config.organizationId])) as BwCollection[];
    for (const collection of list) this.collections.set(collection.name, collection.id);
    if (this.collections.has(name) || !create) return this.collections.get(name);
    const created = JSON.parse(await this.bw(['create', 'org-collection', '--organizationid', this.config.organizationId],
      encode({ organizationId: this.config.organizationId, name, externalId: null, groups: [] }))) as BwCollection;
    this.collections.set(name, created.id);
    return created.id;
  }

  private async itemsIn(collectionId: string): Promise<BwItem[]> {
    return JSON.parse(await this.bw(['list', 'items', '--collectionid', collectionId])) as BwItem[];
  }
}
