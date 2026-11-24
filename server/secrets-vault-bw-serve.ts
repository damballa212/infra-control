import { spawn } from 'node:child_process';
import {
  bwEnv, encode, execFileRunner, LOGIN, openSession, SECURE_NOTE, VaultRejected,
  type BwCollection, type BwItem, type BwRunner, type BwVaultConfig
} from './secrets-vault-bw.js';
import type { VaultAdapter, VaultItem, VaultTarget } from './secrets-vault.js';

/**
 * Conector con Vaultwarden mediante `bw serve` (Vault Management API oficial). Un proceso de larga vida, con la bóveda
 * desbloqueada en memoria, que solo escucha en 127.0.0.1 dentro del contenedor y lo supervisa este objeto: arranca con el
 * panel, se reinicia si muere y se cierra al apagar. La CLI se usa únicamente para abrir sesión y crear colecciones nuevas
 * (el `POST /object/org-collection` de `bw serve` falla). Los valores nunca viajan por argumentos de proceso ni por logs.
 */
export type ServeHandle = { port: number; stop(): Promise<void>; exited: Promise<void> };
export type ServeLauncher = (session: string) => Promise<ServeHandle>;
export type BwServeConfig = BwVaultConfig & { servePort?: number; indexRefreshMs?: number; requestTimeoutMs?: number };
export type BwServeDeps = { runner?: BwRunner; launcher?: ServeLauncher; fetchFn?: typeof fetch; now?: () => number };

const DEFAULT_PORT = 8087;
const INDEX_REFRESH_MS = 30_000;
const INDEX_MAX_AGE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 30_000;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;

/** Fallo de la API local; nunca incluye el cuerpo de la respuesta (podría contener datos). */
class ServeCallError extends Error {
  constructor(readonly status: number, readonly network: boolean) { super(network ? 'bw serve no respondió' : `bw serve respondió ${status}`); }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Lanza `bw serve` sin shell, solo en loopback, con la sesión por entorno y sin conservar su salida. */
export function spawnBwServe(config: BwServeConfig, session: string): ServeHandle {
  const port = config.servePort ?? DEFAULT_PORT;
  const child = spawn(config.bwPath ?? 'bw', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: bwEnv(config, session), stdio: 'ignore'
  });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  };
  return { port, stop, exited };
}

type Index = { collections: Map<string, string>; items: Map<string, VaultItem[]>; at: number };

export class BwServeVault implements VaultAdapter {
  private readonly run: BwRunner;
  private readonly launch: ServeLauncher;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private session: string | null = null;
  private handle: ServeHandle | null = null;
  private starting: Promise<ServeHandle> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private index: Index | null = null;
  private refreshing: Promise<Index> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelay = RESTART_MIN_MS;
  private closed = false;

  constructor(private readonly config: BwServeConfig, deps: BwServeDeps = {}) {
    this.run = deps.runner ?? execFileRunner(config.bwPath ?? 'bw', config.timeoutMs ?? 60_000);
    this.launch = deps.launcher ?? (async session => spawnBwServe(config, session));
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Arranca `bw serve`, carga el índice y empieza a refrescarlo en segundo plano. */
  async warmUp(): Promise<void> {
    await this.ensureServe();
    await this.refreshIndex();
    this.timer ??= setInterval(() => { void this.refreshIndex().catch(() => undefined); }, this.config.indexRefreshMs ?? INDEX_REFRESH_MS);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.timer = this.restartTimer = null;
    const handle = this.handle ?? await this.starting?.catch(() => null) ?? null;
    this.handle = null;
    await handle?.stop();
  }

  async list(collection: string): Promise<VaultItem[]> {
    const index = await this.currentIndex();
    return (index.items.get(collection) ?? []).map(item => ({ ...item }));
  }

  async get(itemRef: string): Promise<string> {
    let item: BwItem;
    try { item = await this.fetchItem(itemRef); }
    catch (error) {
      if (error instanceof VaultRejected) throw error;
      // Puede ser un ítem recién creado desde otro cliente: una sincronización y una nueva lectura (lecturas son idempotentes).
      try { await this.api('POST', '/sync'); item = await this.fetchItem(itemRef); }
      catch (retry) { throw retry instanceof VaultRejected ? retry : new Error('La bóveda no completó la operación.'); }
    }
    if (item.organizationId !== this.config.organizationId) throw new VaultRejected('El ítem no pertenece a la organización de agentes.');
    const value = item.type === LOGIN ? item.login?.password : item.notes;
    if (typeof value !== 'string' || value.length === 0) throw new VaultRejected('El ítem no tiene valor.');
    return value;
  }

  /** Escrituras de una en una y sin reintentar la escritura misma: una repetición ambigua podría duplicar ítems (#241). */
  put(target: VaultTarget, value: string): Promise<string> {
    const task = async (): Promise<string> => {
      await this.ensureServe();
      // La copia local debe estar al día antes de decidir entre crear y editar (si no, un ítem creado por otro cliente se
      // duplicaría). Sincronizar cuesta ~3 s con 0,75 CPU: solo se hace si la última sincronización tiene más de 30 s.
      if (!this.index || this.now() - this.index.at >= (this.config.indexRefreshMs ?? INDEX_REFRESH_MS)) await this.api('POST', '/sync');
      const collectionId = await this.collectionId(target.collection);
      const existing = (await this.api('GET', `/list/object/items?organizationId=${this.org}&collectionId=${encodeURIComponent(collectionId)}`) as BwItem[])
        .find(item => item.name === target.name && item.type === SECURE_NOTE);
      let saved: BwItem;
      if (existing) {
        const full = await this.fetchItem(existing.id);
        saved = await this.api('PUT', `/object/item/${encodeURIComponent(existing.id)}`, { ...full, notes: value }) as BwItem;
      } else {
        saved = await this.api('POST', '/object/item', {
          type: SECURE_NOTE, secureNote: { type: 0 }, name: target.name, notes: value, organizationId: this.config.organizationId,
          collectionIds: [collectionId], favorite: false, fields: [], login: null, card: null, identity: null, reprompt: 0
        }) as BwItem;
      }
      this.recordWrite(target.collection, saved);
      return saved.id;
    };
    const next = this.writes.then(task, task);
    this.writes = next.catch(() => undefined);
    return next.catch((error: unknown) => {
      this.invalidate();
      throw error instanceof VaultRejected ? error : new Error('La bóveda no completó la operación.');
    });
  }

  private get org(): string { return encodeURIComponent(this.config.organizationId); }

  private async fetchItem(itemRef: string): Promise<BwItem> {
    return await this.api('GET', `/object/item/${encodeURIComponent(itemRef)}`) as BwItem;
  }

  // ---- índice en memoria: nombres → itemRef por colección, sin valores ----

  private async currentIndex(): Promise<Index> {
    const index = this.index;
    if (index && this.now() - index.at < INDEX_MAX_AGE_MS) {
      if (this.now() - index.at >= (this.config.indexRefreshMs ?? INDEX_REFRESH_MS)) void this.refreshIndex().catch(() => undefined);
      return index;
    }
    try { return await this.refreshIndex(); }
    catch { throw new Error('La bóveda no completó la operación.'); }
  }

  private refreshIndex(): Promise<Index> {
    this.refreshing ??= this.loadIndex().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async loadIndex(): Promise<Index> {
    // `bw serve` lee su copia local: sin sincronizar no vería ítems creados desde otro cliente o proceso.
    await this.api('POST', '/sync');
    const collections = await this.api('GET', `/list/object/org-collections?organizationId=${this.org}`) as BwCollection[];
    const items = await this.api('GET', `/list/object/items?organizationId=${this.org}`) as BwItem[];
    const names = new Map(collections.map(collection => [collection.id, collection.name]));
    const index: Index = { collections: new Map(collections.map(collection => [collection.name, collection.id])), items: new Map(), at: this.now() };
    for (const item of items) {
      if (item.type !== SECURE_NOTE && item.type !== LOGIN) continue;
      for (const id of item.collectionIds ?? []) {
        const name = names.get(id);
        if (!name) continue;
        const list = index.items.get(name) ?? [];
        list.push({ itemRef: item.id, name: item.name, updatedAt: item.revisionDate });
        index.items.set(name, list);
      }
    }
    this.index = index;
    return index;
  }

  /** Tras una escritura el índice se corrige al instante y se vuelve a cargar de fondo. Sin valores. */
  private recordWrite(collection: string, saved: BwItem): void {
    if (this.index) {
      const list = (this.index.items.get(collection) ?? []).filter(item => item.itemRef !== saved.id);
      list.push({ itemRef: saved.id, name: saved.name, updatedAt: saved.revisionDate });
      this.index.items.set(collection, list);
    }
    this.invalidate();
  }

  private invalidate(): void { void this.refreshIndex().catch(() => undefined); }

  private async collectionId(name: string): Promise<string> {
    const known = this.index?.collections.get(name);
    if (known) return known;
    const find = async (): Promise<string | undefined> =>
      (await this.api('GET', `/list/object/org-collections?organizationId=${this.org}`) as BwCollection[]).find(collection => collection.name === name)?.id;
    const found = await find();
    if (found) return found;
    // Colección nueva: la CLI la crea (una vez por proyecto/entorno) y `bw serve` la aprende con una sincronización.
    const created = JSON.parse(await this.run(['create', 'org-collection', '--organizationid', this.config.organizationId],
      bwEnv(this.config, this.session), encode({ organizationId: this.config.organizationId, name, externalId: null, groups: [] }))) as BwCollection;
    await this.api('POST', '/sync');
    return created.id;
  }

  // ---- proceso `bw serve` y llamadas HTTP locales ----

  private async ensureServe(): Promise<ServeHandle> {
    if (this.handle) return this.handle;
    if (this.closed) throw new Error('La bóveda está cerrada.');
    this.starting ??= this.startServe().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startServe(): Promise<ServeHandle> {
    this.session ??= await openSession(this.run, this.config);
    const handle = await this.launch(this.session);
    try { await this.waitReady(handle); }
    catch (error) { await handle.stop().catch(() => undefined); this.session = null; throw error; }
    if (this.closed) { await handle.stop(); throw new Error('La bóveda está cerrada.'); }
    this.handle = handle;
    this.restartDelay = RESTART_MIN_MS;
    void handle.exited.then(() => this.onExit(handle));
    return handle;
  }

  private async waitReady(handle: ServeHandle): Promise<void> {
    const deadline = this.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        const status = await this.rawCall(handle.port, 'GET', '/status') as { template?: { status?: string } };
        if (status?.template?.status === 'unlocked') return;
        throw new ServeCallError(423, false);
      } catch (error) {
        if (error instanceof ServeCallError && error.status === 423) throw error;
        if (this.now() >= deadline) throw new Error('bw serve no arrancó a tiempo.');
        await sleep(100);
      }
    }
  }

  /** Si el proceso muere sin que lo hayamos cerrado: se descarta la sesión y se reinicia con espera creciente. */
  private onExit(handle: ServeHandle): void {
    if (this.handle !== handle) return;
    this.handle = null;
    this.session = null;
    if (this.closed) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensureServe().then(() => this.refreshIndex()).catch(() => this.onExit(handle));
    }, delay);
    this.restartTimer.unref();
  }

  private async rawCall(port: number, method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`http://127.0.0.1:${port}${path}`, {
        method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
      });
    } catch { throw new ServeCallError(0, true); }
    let json: { success?: boolean; data?: unknown } | null = null;
    try { json = await response.json() as { success?: boolean; data?: unknown }; } catch { /* cuerpo no JSON */ }
    if (!response.ok || !json || json.success === false) throw new ServeCallError(response.status, false);
    return json.data;
  }

  /** Llamada con el proceso al día. Una lectura se reintenta una vez si el proceso había muerto; una escritura nunca. */
  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const write = method === 'POST' || method === 'PUT';
    let handle = await this.ensureServe();
    try { return this.unwrap(await this.rawCall(handle.port, method, path, body), path); }
    catch (error) {
      if (write || !(error instanceof ServeCallError)) throw error;
      if (error.status === 404) throw new VaultRejected('El ítem no existe.');
      if (!error.network && error.status < 500) throw error;
      this.handle = null; this.session = null; await handle.stop().catch(() => undefined);
      handle = await this.ensureServe();
      return this.unwrap(await this.rawCall(handle.port, method, path, body), path);
    }
  }

  /** Las rutas `list` devuelven `{ data: [...] }`; las de objeto, el objeto. */
  private unwrap(result: unknown, path: string): unknown {
    if (!path.startsWith('/list/')) return result ?? {};
    const list = (result as { data?: unknown } | null)?.data;
    return Array.isArray(list) ? list : [];
  }
}
