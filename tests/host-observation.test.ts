import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { CatalogRepository } from '../server/catalog.js';
import { hostConfigurationsSchema } from '../server/host-config.js';
import { HostObservationCoordinator, readTrustedHostSnapshot, type TrustedFileIO, type TrustedStat } from '../server/host-observation.js';
import { decodeHostSnapshot, legacyHostSnapshot, HOST_MAX_BYTES, HOST_TTL_MS, nativeHostMetrics, type HostSnapshot } from '../server/host-observation-schema.js';
import { hostCatalogSnapshots } from '../server/host-catalog.js';

const base = Date.parse('2026-11-14T10:00:00.000Z');
const stamp = (offset = 0) => new Date(base + offset).toISOString();
const fingerprint = 'a'.repeat(64), id = 'b'.repeat(64);
const boot = '12345678-1234-4234-8234-123456789012';
const configuration = { key: 'vps-main', displayName: 'VPS', enabled: true, snapshotDirectory: '/run/infra-host/main', expectedFingerprint: fingerprint };
function fixture(sequence = 1, offset = 0): HostSnapshot {
  const at = stamp(offset);
  return { schemaVersion: 1, fingerprint, bootId: boot, sequence, startedAt: at, completedAt: at,
    host: { observedAt: at, status: 'complete', errors: [], cpu: null, memory: { totalBytes: 8192, availableBytes: 2048, observedAt: at }, rootfs: { totalBytes: 16384, freeBytes: 4096, availableBytes: 2048, observedAt: at } },
    docker: { startedAt: at, observedAt: at, complete: true, errors: [], containers: [{ id, name: 'worker', image: 'worker:1', status: 'running', healthStatus: null, startedAt: stamp(-60_000), finishedAt: null, restartCount: 0, labels: { 'com.docker.compose.project': 'not-authority' } }] } };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const digest = (value: HostSnapshot) => createHash('sha256').update(encode(value)).digest('hex');
function harness() {
  const store = new Store(':memory:');
  let now = base, configs = [configuration], value = encode(fixture());
  let reader: (path: string) => Promise<Uint8Array> = async () => value;
  const catalog = new CatalogRepository(store, () => now);
  const coordinator = new HostObservationCoordinator(() => configs, store, catalog, { now: () => now, read: path => reader(path) });
  return { store, catalog, coordinator, time: (v: number) => { now = v; }, config: (v: typeof configs) => { configs = v; }, sample: (v: HostSnapshot) => { value = encode(v); }, reader: (v: typeof reader) => { reader = v; }, close: () => { coordinator.close(); store.close(); } };
}
function fileIO(data = encode(fixture())) {
  const directory: TrustedStat = { kind: 'directory', uid: 0, gid: 0, mode: 0o755, size: 0, dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1, nlink: 1 };
  const file: TrustedStat = { ...directory, kind: 'file', gid: 1000, mode: 0o640, size: data.length, ino: 2 };
  let closed = false, flags = 0;
  const io: TrustedFileIO = {
    lstat: async path => path.endsWith('snapshot.json') ? { ...file } : path === configuration.snapshotDirectory ? { ...directory, gid: 1000, mode: 0o750 } : { ...directory },
    open: async (_path, value) => { flags = value; return { stat: async () => ({ ...file }), read: async (buffer, offset, length, position) => { const count = Math.max(0, Math.min(length, data.length - position)); data.copy(buffer, offset, position, position + count); return { bytesRead: count }; }, close: async () => { closed = true; } }; }
  };
  return { io, file, directory, closed: () => closed, flags: () => flags };
}

describe('host observation foundation', () => {
  it('accepts a real schema and reuses HostMetricsSnapshot without OTLP', () => {
    const value = decodeHostSnapshot(encode(fixture()), fingerprint, base);
    const metrics = nativeHostMetrics(value);
    expect(metrics.memory).toMatchObject({ usedBytes: 6144, totalBytes: 8192, utilizationPercent: 75 });
    expect(metrics.filesystems?.[0]?.utilizationPercent).toBeCloseTo(100 * 12288 / (12288 + 2048));
    value.host.rootfs!.freeBytes = value.host.rootfs!.totalBytes;
    value.host.rootfs!.availableBytes = 0;
    expect(nativeHostMetrics(value).filesystems).toBeUndefined();
    expect(nativeHostMetrics(value).cpu).toBeUndefined();
  });
  it.each(['extra', 'short_id', 'control', 'secret_label', 'memory_range', 'duplicate_id'])('rejects malformed snapshot: %s', kind => {
    const value = fixture();
    let input: unknown = value;
    if (kind === 'extra') input = { ...value, environment: 'must-not-pass' };
    if (kind === 'short_id') value.docker.containers[0]!.id = 'b'.repeat(12);
    if (kind === 'control') value.docker.containers[0]!.name = 'x\u0085y';
    if (kind === 'secret_label') input = { ...value, docker: { ...value.docker, containers: [{ ...value.docker.containers[0], labels: { 'coolify.projectName': 'private' } }] } };
    if (kind === 'memory_range') value.host.memory!.availableBytes = 9000;
    if (kind === 'duplicate_id') value.docker.containers.push({ ...value.docker.containers[0]! });
    expect(() => decodeHostSnapshot(encode(input), fingerprint, base)).toThrow('snapshot_invalid');
  });
  it('rejects invalid encoding, oversized data and a fingerprint mismatch', () => {
    expect(() => decodeHostSnapshot(Uint8Array.from([0xff]), fingerprint, base)).toThrow('snapshot_invalid');
    expect(() => decodeHostSnapshot(Buffer.alloc(HOST_MAX_BYTES + 1), fingerprint, base)).toThrow('snapshot_too_large');
    expect(() => decodeHostSnapshot(encode(fixture()), 'c'.repeat(64), base)).toThrow('fingerprint_mismatch');
  });
  it('checks actual windows, future skew and the exact expiration boundary', () => {
    const value = fixture(); value.startedAt = stamp(-25_001);
    expect(() => decodeHostSnapshot(encode(value), fingerprint, base)).toThrow('snapshot_invalid');
    expect(() => decodeHostSnapshot(encode(fixture()), fingerprint, base - 5001)).toThrow('snapshot_future');
    expect(() => decodeHostSnapshot(encode(fixture()), fingerprint, base + HOST_TTL_MS)).toThrow('snapshot_expired');
  });
  it('validates private configuration and duplicate enrollment inputs', () => {
    expect(hostConfigurationsSchema.parse([configuration])).toEqual([configuration]);
    expect(hostConfigurationsSchema.safeParse([{ ...configuration, snapshotDirectory: '/run/../etc' }]).success).toBe(false);
    expect(hostConfigurationsSchema.safeParse([configuration, { ...configuration, key: 'other' }]).success).toBe(false);
  });
  it('reads a trusted file with NOFOLLOW and always closes the handle', async () => {
    const source = fileIO();
    expect(await readTrustedHostSnapshot(configuration.snapshotDirectory, source.io)).toEqual(encode(fixture()));
    expect(source.flags() & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(source.closed()).toBe(true);
  });
  it.each(['symlink', 'owner', 'write', 'size'])('rejects untrusted file metadata: %s', kind => {
    const source = fileIO();
    if (kind === 'symlink') source.file.kind = 'symlink';
    if (kind === 'owner') source.file.uid = 1000;
    if (kind === 'write') source.file.mode = 0o660;
    if (kind === 'size') source.file.size = HOST_MAX_BYTES + 1;
    return expect(readTrustedHostSnapshot(configuration.snapshotDirectory, source.io)).rejects.toThrow('untrusted_source');
  });
  it('rejects a writable ancestor and a changed file while closing it', async () => {
    const parent = fileIO(); parent.directory.mode = 0o777;
    await expect(readTrustedHostSnapshot(configuration.snapshotDirectory, parent.io)).rejects.toThrow('untrusted_source');
    const source = fileIO(), originalOpen = source.io.open;
    source.io.open = async (path, flags) => { const handle = await originalOpen(path, flags); const read = handle.read; handle.read = async (...args) => { const result = await read(...args); source.file.mtimeMs++; return result; }; return handle; };
    await expect(readTrustedHostSnapshot(configuration.snapshotDirectory, source.io)).rejects.toThrow('untrusted_source');
    expect(source.closed()).toBe(true);
  });
  it('tolerates unrelated ancestor directory activity and rejects a permission change', async () => {
    const source = fileIO(), original = source.io.open;
    source.io.open = async (path, flags) => {
      const handle = await original(path, flags);
      source.directory.mtimeMs++;
      source.directory.ctimeMs++;
      source.directory.nlink++;
      return handle;
    };
    await expect(readTrustedHostSnapshot(configuration.snapshotDirectory, source.io)).resolves.toEqual(encode(fixture()));
    source.io.open = async (path, flags) => {
      const handle = await original(path, flags);
      source.directory.mode = 0o775;
      return handle;
    };
    await expect(readTrustedHostSnapshot(configuration.snapshotDirectory, source.io)).rejects.toThrow('untrusted_source');
  });
  it.each([false, true])('bounds atomic replacement retries (continuous=%s)', async continuous => {
    const source = fileIO(), original = source.io.open;
    let opens = 0, closes = 0;
    source.io.open = async (path, flags) => {
      const handle = await original(path, flags), opened = await handle.stat();
      opens++;
      if (opens === 1 || continuous) source.file.ino++;
      return { ...handle, stat: async () => ({ ...opened, nlink: opened.ino === source.file.ino ? 1 : 0 }), close: async () => { closes++; await handle.close(); } };
    };
    const reading = readTrustedHostSnapshot(configuration.snapshotDirectory, source.io);
    if (continuous) await expect(reading).rejects.toThrow('untrusted_source');
    else await expect(reading).resolves.toEqual(encode(fixture()));
    expect({ opens, closes }).toEqual({ opens: 2, closes: 2 });
  });
  it('binds an opaque immutable account and uses full physical container IDs', async () => {
    const h = harness();
    try {
      await h.coordinator.poll();
      const binding = h.store.hostObservations.binding(configuration.key)!;
      expect(binding.accountId).toMatch(/^[a-f0-9-]{36}$/);
      expect(h.coordinator.snapshot().map(item => item.catalog?.providerId)).toContain(id);
      const publicData = JSON.stringify({ connections: h.catalog.connections(), resources: h.coordinator.snapshot() });
      expect(publicData).not.toContain(fingerprint); expect(publicData).not.toContain(configuration.snapshotDirectory); expect(publicData).not.toContain(configuration.key);
      expect(() => h.store.hostObservations.bind(configuration.key, 'd'.repeat(64))).toThrow('enrollment_conflict');
    } finally { h.close(); }
  });
  it('does not reobserve a file after coordinator restart and expires without a new file', async () => {
    const h = harness();
    try {
      await h.coordinator.poll();
      const before = h.catalog.listScopes();
      const restarted = new HostObservationCoordinator(() => [configuration], h.store, h.catalog, { now: () => base, read: async () => encode(fixture()) });
      expect((await restarted.poll())[0]?.status).toBe('duplicate'); restarted.close();
      expect(h.catalog.listScopes()).toEqual(before);
      h.time(base + HOST_TTL_MS);
      const host = h.coordinator.snapshot().find(item => item.kind === 'computer')!;
      expect(host.state).toBe('unknown'); expect(host.health?.presence?.state).toBe('stale'); expect(host.observedAt).toBe(stamp());
    } finally { h.close(); }
  });
  it('clears a source failure with the identical fresh file and preserves partial coverage', async () => {
    const h = harness();
    try {
      const value = fixture();
      value.docker.complete = false; value.docker.errors = ['docker_changed']; value.docker.containers = [];
      h.sample(value); await h.coordinator.poll();
      const scopes = h.catalog.listScopes(), resources = h.catalog.listResources();
      h.reader(async () => { throw new Error('temporary read failure'); });
      expect((await h.coordinator.poll())[0]?.status).toBe('failed');
      expect(h.catalog.listScopes().map(scope => scope.state)).toEqual(['failed', 'failed', 'failed']);
      expect(h.coordinator.snapshot()[0]?.state).toBe('unknown');
      h.time(base + 60_000); h.reader(async () => encode(value));
      expect((await h.coordinator.poll())[0]?.status).toBe('duplicate');
      expect(h.catalog.listScopes()).toEqual(scopes);
      expect(h.catalog.listResources()).toEqual(resources);
      expect(h.store.hostObservations.current(configuration.key)?.sequence).toBe(1);
      expect(h.coordinator.snapshot()[0]).toMatchObject({ state: 'online', observedAt: stamp() });
      h.time(base + HOST_TTL_MS);
      expect((await h.coordinator.poll())[0]).toMatchObject({ status: 'failed', errorCode: 'snapshot_expired' });
      expect(h.coordinator.snapshot()[0]?.state).toBe('unknown');
    } finally { h.close(); }
  });
  it('uses the Docker batch stamp for presence, health and expiry', async () => {
    const h = harness();
    try {
      const value = fixture();
      value.startedAt = stamp(-20_000); value.docker.startedAt = stamp(-19_000);
      const row = value.docker.containers[0]!;
      row.observedAt = stamp(-18_000); row.healthStatus = 'healthy';
      const invalid = { ...value, docker: { ...value.docker, containers: [{ ...row, observedAt: stamp(-20_000) }] } };
      expect(() => decodeHostSnapshot(encode(invalid), fingerprint, base)).toThrow('snapshot_invalid');
      h.sample(value); await h.coordinator.poll();
      const child = () => h.coordinator.snapshot().find(resource => resource.kind === 'service')!;
      expect(child()).toMatchObject({ observedAt: stamp(-18_000), coverage: { observedAt: stamp() }, health: { presence: { observedAt: stamp(-18_000) }, service: { state: 'healthy', observedAt: stamp(-18_000) } } });
      h.time(base + HOST_TTL_MS - 18_000);
      expect(child().health?.presence?.state).toBe('stale');
      expect(child().health?.service?.state).toBe('unknown');
      expect(child().coverage?.state).toBe('healthy');
    } finally { h.close(); }
  });
  it('pairs v2 with the committed v1 and preserves legacy state through rollback and re-upgrade', async () => {
    const h = harness();
    let now = base;
    let canonical = fixture();
    let precise: HostSnapshot | undefined;
    const coordinator = new HostObservationCoordinator(() => [configuration], h.store, h.catalog, {
      now: () => now, read: async () => encode(canonical),
      readPrecise: async () => { if (!precise) throw new Error('fixture has no supplement'); return encode(precise); }
    });
    try {
      expect((await coordinator.poll())[0]?.status).toBe('accepted');
      now += 60_000;
      precise = fixture(2, 60_000); precise.schemaVersion = 2;
      precise.startedAt = stamp(50_000); precise.docker.startedAt = stamp(50_000);
      precise.docker.containers[0]!.observedAt = stamp(55_000);
      const missingStamp = { ...precise, docker: { ...precise.docker, containers: canonical.docker.containers } };
      expect(() => decodeHostSnapshot(encode(missingStamp), fingerprint, now)).toThrow('snapshot_invalid');
      expect((await coordinator.poll())[0]?.status).toBe('duplicate');
      canonical = legacyHostSnapshot(precise);
      expect((await coordinator.poll())[0]?.status).toBe('accepted');
      expect(coordinator.snapshot().find(row => row.catalog?.providerId === id)?.observedAt).toBe(stamp(55_000));
      const row = () => h.store.db.prepare('SELECT payload,digest,last_docker AS lastDocker FROM host_observation_state').get() as {payload:string;digest:string;lastDocker:string};
      // El lector v1 exige la versión 1 y el conjunto cerrado de campos del contenedor.
      const legacyReader = (json: string) => {
        const sample = JSON.parse(json) as HostSnapshot;
        if (sample.schemaVersion !== 1 || sample.docker.containers.some(container => Object.hasOwn(container, 'observedAt'))) throw new Error('legacy_schema');
        return decodeHostSnapshot(Buffer.from(json), fingerprint, now);
      };
      expect(() => legacyReader(JSON.stringify(precise))).toThrow('legacy_schema');
      expect(legacyReader(row().payload).host.memory).toEqual(canonical.host.memory);
      expect(legacyReader(row().lastDocker).sequence).toBe(2);
      expect(row().digest).toBe(digest(canonical));
      // Simular la escritura del lector anterior sobre el mismo estado con la siguiente publicación v1.
      now += 60_000; canonical = fixture(3, 120_000);
      const rollback = legacyReader(JSON.stringify(canonical));
      h.store.db.prepare('UPDATE host_observation_state SET payload=?, digest=?, last_docker=?').run(JSON.stringify(rollback), digest(rollback), JSON.stringify(rollback));
      expect(h.store.hostObservations.current(configuration.key)?.sequence).toBe(3);
      expect(h.store.hostObservations.lastCompleteDocker(configuration.key)?.schemaVersion).toBe(1);
      expect((await coordinator.poll())[0]?.status).toBe('duplicate');
      now += 60_000; precise = fixture(4, 180_000); precise.schemaVersion = 2;
      precise.docker.containers[0]!.observedAt = stamp(180_000);
      canonical = legacyHostSnapshot(precise);
      expect((await coordinator.poll())[0]?.status).toBe('accepted');
      expect(h.store.hostObservations.current(configuration.key)?.schemaVersion).toBe(2);
      now += 60_000; canonical = fixture(3, 120_000);
      expect((await coordinator.poll())[0]).toMatchObject({ status: 'failed', errorCode: 'replay_conflict' });
    } finally { coordinator.close(); h.close(); }
  });
  it.each(['accept', 'startup', 'duplicate'] as const)('persists strict v1 bases after %s while retaining original sequence, digest and timing', mode => {
    const directory = mkdtempSync(join(tmpdir(), 'host-observation-v1-'));
    const path = join(directory, 'infra.sqlite');
    const value = fixture();
    value.startedAt = stamp(-2_000); value.docker.startedAt = stamp(-2_000);
    value.docker.containers[0]!.observedAt = stamp(-1_000);
    const originalDigest = digest(value);
    const seedLegacyRow = (store: Store) => {
      store.db.prepare('DELETE FROM host_observation_precise WHERE enrollment_key=?').run(configuration.key);
      store.db.prepare('UPDATE host_observation_state SET payload=?,last_docker=? WHERE enrollment_key=?').run(JSON.stringify(value), JSON.stringify(value), configuration.key);
    };
    let store: Store | undefined;
    try {
      store = new Store(path);
      store.hostObservations.bind(configuration.key, fingerprint);
      expect(store.hostObservations.accept(configuration.key, value, originalDigest, () => {})).toBe('accepted');
      if (mode !== 'accept') seedLegacyRow(store);
      if (mode === 'startup') {
        store.close(); store = undefined;
        store = new Store(path);
      }
      if (mode === 'duplicate') {
        expect(store.hostObservations.accept(configuration.key, value, originalDigest, () => { throw new Error('duplicate apply'); })).toBe('duplicate');
      }
      for (const sample of [store.hostObservations.current(configuration.key), store.hostObservations.lastCompleteDocker(configuration.key)]) {
        expect(sample?.docker.containers[0]?.observedAt).toBe(stamp(-1_000));
        expect(sample?.sequence).toBe(value.sequence);
      }
      store.close(); store = undefined;
      const legacy = new DatabaseSync(path, { readOnly: true });
      try {
        const row = legacy.prepare('SELECT payload,digest,last_docker AS lastDocker FROM host_observation_state').get() as { payload: string; digest: string; lastDocker: string };
        expect(row.digest).toBe(originalDigest);
        for (const payload of [row.payload, row.lastDocker]) {
          const decoded = decodeHostSnapshot(Buffer.from(payload), fingerprint, base);
          expect(decoded).toEqual(legacyHostSnapshot(value));
          expect(JSON.parse(payload).docker.containers.every((container: object) => !Object.hasOwn(container, 'observedAt'))).toBe(true);
        }
      } finally { legacy.close(); }
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('preserves rows and their observation times on partial Docker snapshots', async () => {
    const h = harness();
    try {
      await h.coordinator.poll();
      const old = h.catalog.listResources().find(item => item.resourceType === 'docker-container')!;
      const next = fixture(2, 60_000); next.docker.complete = false; next.docker.errors = ['docker_changed']; next.docker.containers = [];
      h.time(base + 60_000); h.sample(next); await h.coordinator.poll();
      expect(h.catalog.listResources().find(item => item.catalogId === old.catalogId)).toMatchObject({ lifecycle: 'active', observedAt: old.observedAt, state: old.state });
      expect(h.store.hostObservations.lastCompleteDocker(configuration.key)?.sequence).toBe(1);
      expect(h.coordinator.snapshot().find(item => item.catalog?.providerId === id)?.health?.service?.state).toBe('unknown');
    } finally { h.close(); }
  });
  it('treats container recreation as a new identity and ignores Compose project authority', async () => {
    const h = harness();
    try {
      await h.coordinator.poll(); const old = h.catalog.listResources().find(item => item.resourceType === 'docker-container')!;
      const next = fixture(2, 60_000); next.docker.containers[0]!.id = 'c'.repeat(64);
      h.time(base + 60_000); h.sample(next); await h.coordinator.poll();
      expect(h.catalog.listResources().filter(item => item.resourceType === 'docker-container')).toHaveLength(2);
      expect(h.catalog.listResources().find(item => item.catalogId === old.catalogId)?.lifecycle).toBe('candidate_missing');
      expect(h.catalog.listProjects()).toEqual([]);
      expect(hostCatalogSnapshots('opaque', 'VPS', next).docker[0]?.tags).toBeUndefined();
    } finally { h.close(); }
  });
  it('requires explicit Docker health; running alone and stopped jobs are unknown', async () => {
    const h = harness();
    try {
      await h.coordinator.poll();
      expect(h.coordinator.snapshot().find(item => item.kind === 'service')?.health?.service?.state).toBe('unknown');
      const healthy = fixture(2, 60_000); healthy.docker.containers[0]!.healthStatus = 'healthy';
      h.time(base + 60_000); h.sample(healthy); await h.coordinator.poll();
      expect(h.coordinator.snapshot().find(item => item.kind === 'service')?.health?.service?.state).toBe('healthy');
      const stopped = fixture(3, 120_000); stopped.docker.containers[0]!.status = 'exited'; stopped.docker.containers[0]!.healthStatus = 'unhealthy';
      h.time(base + 120_000); h.sample(stopped); await h.coordinator.poll();
      const resource = h.coordinator.snapshot().find(item => item.kind === 'service')!;
      expect(resource.health?.service?.state).toBe('unknown'); expect(resource.actions).toEqual([]);
      expect(h.store.eventsAfter(0).filter(event => event.type === 'incident')).toEqual([]);
    } finally { h.close(); }
  });
  it('revalidates disabled configuration after awaited IO', async () => {
    const h = harness();
    try {
      h.reader(async () => { h.config([{ ...configuration, enabled: false }]); return encode(fixture()); });
      await h.coordinator.poll();
      expect(h.coordinator.snapshot()).toEqual([]);
      expect(h.store.hostObservations.current(configuration.key)).toBeUndefined();
    } finally { h.close(); }
  });
  it('fails closed on fingerprint reassignment and hides removed enrollments', async () => {
    const h = harness();
    try {
      await h.coordinator.poll();
      h.config([{ ...configuration, expectedFingerprint: 'e'.repeat(64) }]);
      expect(h.coordinator.snapshot()).toEqual([]);
      expect(h.coordinator.enrollmentConflictCount).toBe(1);
      expect(h.catalog.connections()[0]?.state).toBe('suspended');
      h.config([]); expect(h.coordinator.snapshot()).toEqual([]);
      expect(h.catalog.listResources()).toHaveLength(2);
    } finally { h.close(); }
  });
  it('does not expose raw IO failures or turn a missing file into host off', async () => {
    const h = harness();
    try {
      await h.coordinator.poll(); h.time(base + 60_000);
      h.reader(async () => { throw new Error('/private/path secret stderr'); });
      expect((await h.coordinator.poll())[0]).toMatchObject({ status: 'failed', errorCode: 'source_unavailable' });
      expect(h.coordinator.snapshot().find(item => item.kind === 'computer')?.state).toBe('unknown');
      expect(JSON.stringify(h.store.eventsAfter(0))).not.toContain('secret stderr');
    } finally { h.close(); }
  });
  it('rolls back replay state together with catalog work and rejects old boots', () => {
    const h = harness();
    try {
      h.store.hostObservations.bind(configuration.key, fingerprint);
      expect(() => h.store.hostObservations.accept(configuration.key, fixture(), digest(fixture()), () => { throw new Error('rollback'); })).toThrow('rollback');
      expect(h.store.hostObservations.current(configuration.key)).toBeUndefined();
      h.store.hostObservations.accept(configuration.key, fixture(), digest(fixture()), () => {});
      const next = fixture(2, 60_000); next.bootId = '87654321-1234-4234-8234-123456789012';
      h.store.hostObservations.accept(configuration.key, next, digest(next), () => {});
      const oldBoot = fixture(3, 120_000);
      expect(() => h.store.hostObservations.accept(configuration.key, oldBoot, digest(oldBoot), () => {})).toThrow('replay_conflict');
    } finally { h.close(); }
  });
  it('singleflights polling and does not touch a closed store after pending IO', async () => {
    const h = harness();
    let release: ((value: Uint8Array) => void) | undefined, reads = 0;
    h.reader(() => { reads++; return new Promise(resolve => { release = resolve; }); });
    const first = h.coordinator.poll(), second = h.coordinator.poll();
    expect(first).toBe(second); expect(reads).toBe(1);
    h.close(); release!(encode(fixture()));
    await expect(first).resolves.toEqual([]);
  });
});
