import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Store } from './store.js';
import type { CatalogRepository } from './catalog.js';
import type { HostObservationConfig, Resource } from './types.js';
import { hostConfigurationsSchema, isPrivateSnapshotDirectory } from './host-config.js';
import { hostAlias, hostCatalogSnapshots, projectHostCatalogResource } from './host-catalog.js';
import type { HostSnapshot } from './host-observation-schema.js';
import { decodeHostSnapshot, legacyHostSnapshot, nativeHostMetrics, HOST_CADENCE_MS, HOST_MAX_BYTES, HOST_TTL_MS, HostObservationError, safeHostError } from './host-observation-schema.js';
export { decodeHostSnapshot, HOST_TTL_MS, HostObservationError } from './host-observation-schema.js';
export type { HostSnapshot } from './host-observation-schema.js';

export type TrustedStat = { kind: 'file' | 'directory' | 'other' | 'symlink'; uid: number; gid: number; mode: number; size: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number; nlink: number };
export interface TrustedHandle {
  stat(): Promise<TrustedStat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface TrustedFileIO { lstat(path: string): Promise<TrustedStat>; open(path: string, flags: number): Promise<TrustedHandle> }
const statValue = (value: Stats): TrustedStat => ({ kind: value.isSymbolicLink() ? 'symlink' : value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other', uid: value.uid, gid: value.gid, mode: value.mode, size: value.size, dev: value.dev, ino: value.ino, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, nlink: value.nlink });
export const nodeTrustedFileIO: TrustedFileIO = {
  lstat: async path => statValue(await lstat(path)),
  open: async (path, flags) => {
    const handle = await open(path, flags);
    return { stat: async () => statValue(await handle.stat()), read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: () => handle.close() };
  }
};
const sameIdentity = (a: TrustedStat, b: TrustedStat): boolean => a.dev === b.dev && a.ino === b.ino;
const samePermissions = (a: TrustedStat, b: TrustedStat): boolean => sameIdentity(a, b) && a.kind === b.kind && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
const same = (a: TrustedStat, b: TrustedStat): boolean => samePermissions(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
class SnapshotRotated extends Error {}
function trustFile(value: TrustedStat): void {
  if (value.kind !== 'file' || value.uid !== 0 || value.gid !== 1000 || (value.mode & 0o7777) !== 0o640 || value.nlink !== 1 || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > HOST_MAX_BYTES) throw new HostObservationError('untrusted_source');
}
type SnapshotFile = 'snapshot.json' | 'snapshot.v2.json';
export async function readTrustedHostSnapshot(directory: string, io: TrustedFileIO = nodeTrustedFileIO, file: SnapshotFile = 'snapshot.json'): Promise<Uint8Array> {
  if (!isPrivateSnapshotDirectory(directory)) throw new HostObservationError('untrusted_source');
  for (let attempt = 0; ; attempt++) {
    try { return await readTrustedHostSnapshotOnce(directory, io, file); }
    catch (error) {
      if (error instanceof SnapshotRotated) {
        if (attempt === 0) continue;
        throw new HostObservationError('untrusted_source');
      }
      throw error instanceof HostObservationError ? error : new HostObservationError('source_unavailable');
    }
  }
}
async function readTrustedHostSnapshotOnce(directory: string, io: TrustedFileIO, file: SnapshotFile): Promise<Uint8Array> {
  let handle: TrustedHandle | undefined;
  try {
    const parents = ['/'];
    let current = '';
    for (const part of directory.slice(1).split('/')) { current += '/' + part; parents.push(current); }
    const metadata: TrustedStat[] = [];
    for (const path of parents) {
      const value = await io.lstat(path);
      if (value.kind !== 'directory' || value.uid !== 0 || (value.mode & 0o022) !== 0 || path === directory && (value.gid !== 1000 || (value.mode & 0o7777) !== 0o750)) throw new HostObservationError('untrusted_source');
      metadata.push(value);
    }
    const verifyParents = async () => {
      for (let index = 0; index < parents.length; index++) {
        if (!samePermissions(metadata[index]!, await io.lstat(parents[index]!))) throw new HostObservationError('untrusted_source');
      }
    };
    const path = posix.join(directory, file);
    const before = await io.lstat(path); trustFile(before);
    handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!sameIdentity(before, opened) || opened.nlink === 0) {
      const replacement = await io.lstat(path); trustFile(replacement);
      await verifyParents();
      if (!sameIdentity(before, replacement)) throw new SnapshotRotated();
    }
    trustFile(opened);
    if (!same(before, opened)) throw new HostObservationError('untrusted_source');
    const buffer = Buffer.alloc(HOST_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, Math.min(65536, buffer.length - size), size);
      if (!Number.isInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > Math.min(65536, buffer.length - size)) throw new HostObservationError('untrusted_source');
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > HOST_MAX_BYTES) throw new HostObservationError('snapshot_too_large');
    const after = await handle.stat();
    const named = await io.lstat(path); trustFile(named);
    await verifyParents();
    if (!sameIdentity(opened, named)) throw new SnapshotRotated();
    trustFile(after);
    if (!same(opened, after) || size !== after.size || !same(after, named)) throw new HostObservationError('untrusted_source');
    return buffer.subarray(0, size);
  } finally { await handle?.close(); }
}
export type HostPollResult = { accountId: string; status: 'accepted' | 'duplicate' | 'failed'; errorCode?: string };
export class HostObservationCoordinator {
  private pending: Promise<HostPollResult[]> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private listeners = new Set<() => void>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private published = '';
  lastErrorCode: string | null = null;
  enrollmentConflictCount = 0;
  constructor(private readonly configuration: () => readonly HostObservationConfig[], private readonly store: Store, private readonly catalog: CatalogRepository, private readonly io: { now: () => number; read: (directory: string) => Promise<Uint8Array>; readPrecise?: (directory: string) => Promise<Uint8Array> } = { now: Date.now, read: readTrustedHostSnapshot }) {}
  private configure(): HostObservationConfig[] {
    const parsed = hostConfigurationsSchema.safeParse(this.configuration());
    if (!parsed.success) throw new HostObservationError('host_configuration_invalid');
    const configs: HostObservationConfig[] = [];
    let conflicts = 0;
    for (const config of parsed.data) {
      let binding: ReturnType<Store['hostObservations']['bind']>;
      try { binding = this.store.hostObservations.bind(config.key, config.expectedFingerprint); }
      catch (error) {
        if (!(error instanceof HostObservationError) || error.code !== 'enrollment_conflict') throw error;
        // Un intento de reutilizar un fingerprint bajo otra key no suspende al titular original.
        const old = this.store.hostObservations.binding(config.key);
        const connection = old && this.catalog.connections().find(item => item.provider === 'host' && item.providerAccountId === old.accountId);
        if (connection) this.catalog.setConnectionState(connection.id, 'suspended');
        conflicts++;
        continue;
      }
      configs.push(config);
      let connection = this.catalog.connections().find(item => item.provider === 'host' && item.providerAccountId === binding.accountId);
      if (!connection || connection.name !== config.displayName) connection = { ...this.catalog.registerConnection({ provider: 'host', providerAccountId: binding.accountId, name: binding.accountId, displayName: config.displayName, credentialRef: `host-observation:${binding.accountId}` }), state: connection?.state ?? 'active' };
      this.catalog.setConnectionState(connection.id, config.enabled ? 'active' : 'suspended');
      this.catalog.seedLegacyResource(connection.id, { providerId: 'machine', resourceType: 'linux-host', region: 'local', name: config.displayName, state: 'unknown', detail: 'Host · sin observación', aliases: [hostAlias(binding.accountId)] });
    }
    for (const binding of this.store.hostObservations.enrollments()) if (!configs.some(config => config.key === binding.key && config.enabled)) {
      const connection = this.catalog.connections().find(item => item.provider === 'host' && item.providerAccountId === binding.accountId);
      if (connection) this.catalog.setConnectionState(connection.id, 'suspended');
    }
    this.enrollmentConflictCount = conflicts;
    return configs;
  }
  activeConnectionIds(): string[] {
    const configs = this.configure();
    const accounts = new Set(configs.filter(config => config.enabled).map(config => this.store.hostObservations.binding(config.key)!.accountId));
    return this.catalog.connections().filter(connection => connection.provider === 'host' && connection.state === 'active' && accounts.has(connection.providerAccountId)).map(connection => connection.id);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(): void {
    if (this.closed) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    let rows: Resource[] = [], signature: string;
    try { rows = this.snapshot(); signature = JSON.stringify(rows); }
    catch (error) { this.lastErrorCode = safeHostError(error); signature = 'unavailable'; }
    if (signature !== this.published) {
      this.published = signature;
      for (const listener of this.listeners) {
        try { listener(); } catch { this.lastErrorCode = 'host_projection_listener_failed'; }
      }
    }
    const now = this.io.now();
    const deadlines = rows.flatMap(resource => [resource.health?.presence?.freshUntil, resource.health?.telemetry?.freshUntil, resource.health?.service?.freshUntil])
      .filter((value): value is string => Boolean(value)).map(Date.parse).filter(value => Number.isFinite(value) && value > now);
    if (deadlines.length) {
      this.expiryTimer = setTimeout(() => { this.expiryTimer = undefined; this.publish(); }, Math.max(1, Math.min(...deadlines) - now));
      this.expiryTimer.unref();
    }
  }
  private failure(connectionId: string, code: string): void {
    const observedAt = new Date(this.io.now()).toISOString();
    this.store.atomic(() => {
      for (const scopeKey of ['host:presence', 'host:metrics', 'host:docker']) {
        this.catalog.setHostScopeReadState(connectionId, scopeKey, { state: 'failed', errorCode: code, at: observedAt });
      }
    });
  }
  private async collect(): Promise<HostPollResult[]> {
    const configs = this.configure().filter(config => config.enabled), results: HostPollResult[] = [];
    for (const original of configs) {
      if (this.closed) break;
      const binding = this.store.hostObservations.binding(original.key)!;
      try {
        const bytes = await this.io.read(original.snapshotDirectory);
        if (this.closed) break;
        // snapshot.json es la publicación de referencia. El complemento puede faltar o estar adelantado por un rename.
        const preciseBytes = await this.io.readPrecise?.(original.snapshotDirectory).catch(() => undefined);
        if (this.closed) break;
        const current = this.configure().find(config => config.key === original.key && config.enabled);
        if (!current || current.snapshotDirectory !== original.snapshotDirectory || current.expectedFingerprint !== original.expectedFingerprint) continue;
        const connection = this.catalog.connections().find(item => item.provider === 'host' && item.providerAccountId === binding.accountId && item.state === 'active');
        if (!connection) continue;
        const now = this.io.now(), base = decodeHostSnapshot(bytes, current.expectedFingerprint, now);
        if (base.schemaVersion !== 1) throw new HostObservationError('snapshot_invalid');
        let sample = base;
        if (preciseBytes) {
          try {
            const precise = decodeHostSnapshot(preciseBytes, current.expectedFingerprint, now);
            if (precise.schemaVersion === 2 && JSON.stringify(legacyHostSnapshot(precise)) === JSON.stringify(base)) sample = precise;
          } catch (error) {
            if (!(error instanceof HostObservationError)) throw error;
          }
        }
        const digest = createHash('sha256').update(bytes).digest('hex');
        const metricsResult = { complete: sample.host.status === 'complete', state: sample.host.status === 'failed' ? 'failed' as const : 'partial' as const, observedAt: sample.host.observedAt, errorCode: sample.host.errors[0] ?? 'host_metrics_partial' };
        const dockerResult = { complete: sample.docker.complete, state: 'partial' as const, observedAt: sample.docker.observedAt, errorCode: sample.docker.errors[0] ?? 'docker_partial' };
        const status = this.store.hostObservations.accept(current.key, sample, digest, () => {
          const mapped = hostCatalogSnapshots(binding.accountId, current.displayName, sample);
          this.catalog.reconcileScope(connection.id, 'host:presence', [mapped.presence], { complete: true, observedAt: sample.completedAt });
          this.catalog.reconcileScope(connection.id, 'host:metrics', [], metricsResult);
          this.catalog.reconcileScope(connection.id, 'host:docker', mapped.docker, dockerResult);
          const metrics = nativeHostMetrics(sample);
          if (metrics.cpu || metrics.memory || metrics.filesystems?.length) this.store.recordHostTelemetry(hostAlias(binding.accountId), metrics, sample.completedAt, now);
        });
        if (status === 'duplicate') this.store.atomic(() => {
          this.catalog.setHostScopeReadState(connection.id, 'host:presence', { state: 'healthy', errorCode: null, at: sample.completedAt, duplicate: true });
          for (const [scopeKey, result] of [['host:metrics', metricsResult], ['host:docker', dockerResult]] as const) {
            this.catalog.setHostScopeReadState(connection.id, scopeKey, {
              state: result.complete ? 'healthy' : result.state, errorCode: result.complete ? null : result.errorCode,
              at: result.observedAt, duplicate: true
            });
          }
        });
        results.push({ accountId: binding.accountId, status });
      } catch (error) {
        if (this.closed) break;
        const code = safeHostError(error);
        this.lastErrorCode = code;
        const current = this.configure().find(config => config.key === original.key && config.enabled && config.expectedFingerprint === original.expectedFingerprint && config.snapshotDirectory === original.snapshotDirectory);
        if (!current) continue;
        const connection = this.catalog.connections().find(item => item.provider === 'host' && item.providerAccountId === binding.accountId && item.state === 'active');
        if (connection) this.failure(connection.id, code);
        results.push({ accountId: binding.accountId, status: 'failed', errorCode: code });
      }
    }
    return results;
  }
  poll(): Promise<HostPollResult[]> {
    if (this.closed) return Promise.resolve([]);
    if (this.pending) return this.pending;
    this.lastErrorCode = null;
    this.pending = this.collect().then(results => { this.publish(); return results; }, error => { this.publish(); throw error; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  start(): void {
    if (this.closed || this.timer) return;
    const run = () => { void this.poll().catch(error => { this.lastErrorCode = safeHostError(error); }); };
    run(); this.timer = setInterval(run, HOST_CADENCE_MS); this.timer.unref();
  }
  snapshot(monitor?: { samples: ReadonlyMap<string, HostSnapshot | undefined>; includeRetiredDocker: (resourceId: string) => boolean; completeDocker: ReadonlyMap<string, HostSnapshot> }): Resource[] {
    if (this.closed) return [];
    const configs = this.configure().filter(config => config.enabled), now = this.io.now();
    const enrollments = new Map(this.store.hostObservations.enrollments().map(item => [item.key, item]));
    const scopeKey = (connectionId: string, key: string) => `${connectionId}:${key}`;
    const scopes = new Map(this.catalog.listScopes().map(scope => [scopeKey(scope.connectionId, scope.scopeKey), scope]));
    const recordsByAccount = new Map<string, ReturnType<CatalogRepository['listResources']>>();
    for (const record of this.catalog.listResources({ includeRetired: Boolean(monitor) })) {
      if (record.provider !== 'host') continue;
      if (record.lifecycle === 'retired' && (record.resourceType !== 'docker-container' || !monitor?.includeRetiredDocker(record.aliases[0] ?? `catalog:${record.catalogId}`))) continue;
      const rows = recordsByAccount.get(record.accountId);
      if (rows) rows.push(record);
      else recordsByAccount.set(record.accountId, [record]);
    }
    const resources: Resource[] = [];
    for (const config of configs) {
      const binding = enrollments.get(config.key)!;
      const sample = monitor ? monitor.samples.get(binding.accountId) : this.store.hostObservations.current(config.key);
      // El catálogo solo incorpora lotes de una enumeración aceptada como completa.
      const dockerCandidate = monitor ? monitor.completeDocker.get(binding.accountId)
        : sample && this.store.hostObservations.completeDockerForBoot(config.key, sample);
      const fullDocker = dockerCandidate && dockerCandidate.bootId === sample?.bootId ? dockerCandidate : undefined;
      const containers = new Map(fullDocker?.docker.containers.map(container => [container.id, container] as const));
      for (const record of recordsByAccount.get(binding.accountId) ?? []) {
        const resource = projectHostCatalogResource(record, scopes.get(scopeKey(record.connectionId, record.scopeKey)), true, now);
        if (record.resourceType === 'linux-host' && sample) {
          const metrics = nativeHostMetrics(sample);
          const stamps = [metrics.cpu?.observedAt, metrics.memory?.observedAt, ...(metrics.filesystems ?? []).map(item => item.observedAt)].filter((value): value is string => Boolean(value));
          const lastAt = stamps.sort().at(-1) ?? null;
          const fresh = lastAt !== null && now - Date.parse(lastAt) < HOST_TTL_MS && now >= Date.parse(lastAt) - 5000;
          if (metrics.cpu || metrics.memory || metrics.filesystems?.length) resource.hostMetrics = metrics;
          resource.health = { ...resource.health, telemetry: { state: !lastAt ? 'unknown' : fresh && resource.coverage?.state === 'healthy' && sample.host.status === 'complete' ? 'fresh' : 'stale', source: 'host-native', observedAt: lastAt, freshUntil: lastAt ? new Date(Date.parse(lastAt) + HOST_TTL_MS).toISOString() : null } };
        } else if (record.resourceType === 'docker-container') {
          const presence = resource.health?.presence;
          if (!fullDocker) {
            resource.state = 'unknown';
            resource.observedAt = null;
            resource.stateChangedAt = null;
            resource.detail = 'Docker · sin observación del arranque actual';
            resource.health = { ...resource.health,
              ...(presence ? { presence: { ...presence, state: 'unknown', observedAt: null, freshUntil: null } } : {}),
              service: { state: 'unknown', source: 'docker-health', observedAt: null, freshUntil: null, reasonCode: 'docker_observation_unavailable' }
            };
            resources.push(resource);
            continue;
          }
          if (presence && record.observedAt) {
            const age = now - Date.parse(record.observedAt);
            presence.state = age < -5000 ? 'unknown' : age >= HOST_TTL_MS ? 'stale' : record.lifecycle === 'active' ? 'fresh' : 'unknown';
          }
          const container = containers.get(record.providerId);
          const observedAt = container ? container.observedAt ?? fullDocker?.docker.observedAt : undefined;
          if (container && observedAt && observedAt === resource.observedAt && presence?.state === 'fresh') {
            const state = container.status === 'running' && container.healthStatus === 'healthy' ? 'healthy' : container.status === 'running' && container.healthStatus === 'unhealthy' ? 'unhealthy' : 'unknown';
            resource.health = { ...resource.health, service: { state, source: 'docker-health', observedAt, freshUntil: presence.freshUntil, reasonCode: state === 'unknown' ? 'health_not_established' : 'docker_health_status' } };
          }
        }
        resources.push(resource);
      }
    }
    return resources;
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.timer = undefined; this.expiryTimer = undefined; this.listeners.clear();
  }
}
