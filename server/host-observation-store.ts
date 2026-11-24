import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { HostObservationError, hostSnapshotSchema, legacyHostSnapshot, type HostSnapshot } from './host-observation-schema.js';

export type HostEnrollment = { key: string; accountId: string; fingerprint: string };
type StateRow = { payload: string; digest: string; lastDocker: string | null };
const payloadHash = (payload: string) => createHash('sha256').update(payload).digest('hex');
const hasPreciseDocker = (sample: HostSnapshot) => sample.schemaVersion === 2 || sample.docker.containers.some(container => container.observedAt !== undefined);
export class HostObservationStore {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS host_enrollments(
      enrollment_key TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS host_observation_boots(
        enrollment_key TEXT NOT NULL, boot_id TEXT NOT NULL, PRIMARY KEY(enrollment_key,boot_id),
        FOREIGN KEY(enrollment_key) REFERENCES host_enrollments(enrollment_key));
      CREATE TABLE IF NOT EXISTS host_observation_state(
        enrollment_key TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL, last_docker TEXT,
        FOREIGN KEY(enrollment_key) REFERENCES host_enrollments(enrollment_key));
      CREATE TABLE IF NOT EXISTS host_observation_precise(
        enrollment_key TEXT NOT NULL, lane TEXT NOT NULL CHECK(lane IN ('current','docker')),
        base_digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(enrollment_key,lane),
        FOREIGN KEY(enrollment_key) REFERENCES host_enrollments(enrollment_key));`);
    this.store.atomic(() => {
      const rows = this.store.db.prepare('SELECT enrollment_key AS key,payload,digest,last_docker AS lastDocker FROM host_observation_state').all() as Array<StateRow & { key: string }>;
      for (const row of rows) this.normalizeStored(row.key, row);
    });
  }
  enrollments(): HostEnrollment[] {
    return this.store.db.prepare('SELECT enrollment_key AS key,account_id AS accountId,fingerprint FROM host_enrollments ORDER BY enrollment_key').all() as HostEnrollment[];
  }
  binding(key: string): HostEnrollment | undefined { return this.enrollments().find(item => item.key === key); }
  bind(key: string, fingerprint: string): HostEnrollment {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new HostObservationError('enrollment_invalid');
    return this.store.atomic(() => {
      const previous = this.binding(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new HostObservationError('enrollment_conflict');
        return previous;
      }
      if (this.enrollments().some(item => item.fingerprint === fingerprint)) throw new HostObservationError('enrollment_conflict');
      const result = { key, fingerprint, accountId: randomUUID() };
      this.store.db.prepare('INSERT INTO host_enrollments(enrollment_key,account_id,fingerprint) VALUES (?,?,?)').run(key, result.accountId, fingerprint);
      return result;
    });
  }
  private row(key: string): StateRow | undefined {
    return this.store.db.prepare('SELECT payload,digest,last_docker AS lastDocker FROM host_observation_state WHERE enrollment_key=?').get(key) as StateRow | undefined;
  }
  private extra(key: string, lane: 'current' | 'docker', digest: string): { payload: string } | undefined {
    return this.store.db.prepare('SELECT payload FROM host_observation_precise WHERE enrollment_key=? AND lane=? AND base_digest=?').get(key, lane, digest) as { payload: string } | undefined;
  }
  private saveExtra(key: string, lane: 'current' | 'docker', digest: string, payload: string | null): void {
    if (payload === null) {
      this.store.db.prepare('DELETE FROM host_observation_precise WHERE enrollment_key=? AND lane=?').run(key, lane);
      return;
    }
    this.store.db.prepare(`INSERT INTO host_observation_precise(enrollment_key,lane,base_digest,payload) VALUES (?,?,?,?)
      ON CONFLICT(enrollment_key,lane) DO UPDATE SET base_digest=excluded.base_digest,payload=excluded.payload`).run(key, lane, digest, payload);
  }
  private normalizeStored(key: string, row: StateRow): StateRow {
    const normalize = (lane: 'current' | 'docker', base: string): string => {
      let raw: unknown;
      try { raw = JSON.parse(base); } catch { return base; }
      const parsed = hostSnapshotSchema.safeParse(raw);
      if (!parsed.success || !hasPreciseDocker(parsed.data)) return base;
      const legacy = JSON.stringify(legacyHostSnapshot(parsed.data));
      const before = lane === 'current' ? row.digest : payloadHash(base);
      const after = lane === 'current' ? row.digest : payloadHash(legacy);
      this.saveExtra(key, lane, after, this.extra(key, lane, before)?.payload ?? base);
      return legacy;
    };
    const payload = normalize('current', row.payload);
    const lastDocker = row.lastDocker === null ? null : normalize('docker', row.lastDocker);
    if (payload === row.payload && lastDocker === row.lastDocker) return row;
    this.store.db.prepare('UPDATE host_observation_state SET payload=?, last_docker=? WHERE enrollment_key=?').run(payload, lastDocker, key);
    return { ...row, payload, lastDocker };
  }
  private readSample(key: string, lane: 'current' | 'docker', base: string, digest: string): HostSnapshot {
    // El lector anterior actualiza la fila base. Un extra de otra secuencia queda automáticamente fuera de uso.
    const extra = this.extra(key, lane, digest);
    try { return hostSnapshotSchema.parse(JSON.parse(extra?.payload ?? base)); }
    catch { throw new HostObservationError('persisted_snapshot_invalid'); }
  }
  current(key: string): HostSnapshot | undefined {
    const row = this.row(key);
    return row ? this.readSample(key, 'current', row.payload, row.digest) : undefined;
  }
  lastCompleteDocker(key: string): HostSnapshot | undefined {
    const row = this.row(key);
    return row?.lastDocker ? this.readSample(key, 'docker', row.lastDocker, payloadHash(row.lastDocker)) : undefined;
  }
  completeDockerForBoot(key: string, sample: HostSnapshot): HostSnapshot | undefined {
    if (sample.docker.complete) return sample;
    const previous = this.lastCompleteDocker(key);
    return previous?.bootId === sample.bootId ? previous : undefined;
  }
  accept(key: string, sample: HostSnapshot, digest: string, apply: () => void): 'accepted' | 'duplicate' {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new HostObservationError('snapshot_invalid');
    return this.store.atomic(() => {
      const binding = this.binding(key);
      if (!binding || binding.fingerprint !== sample.fingerprint) throw new HostObservationError('enrollment_conflict');
      const existing = this.row(key);
      const row = existing && this.normalizeStored(key, existing);
      const previous = row && this.readSample(key, 'current', row.payload, row.digest);
      if (previous) {
        if (sample.sequence === previous.sequence && row?.digest === digest) return 'duplicate';
        if (sample.sequence <= previous.sequence || Date.parse(sample.startedAt) < Date.parse(previous.completedAt) || Date.parse(sample.completedAt) <= Date.parse(previous.completedAt)) throw new HostObservationError('replay_conflict');
        if (sample.bootId !== previous.bootId && this.store.db.prepare('SELECT 1 FROM host_observation_boots WHERE enrollment_key=? AND boot_id=?').get(key, sample.bootId)) throw new HostObservationError('replay_conflict');
      }
      const seen = Boolean(this.store.db.prepare('SELECT 1 FROM host_observation_boots WHERE enrollment_key=? AND boot_id=?').get(key, sample.bootId));
      if (!seen) {
        const count = Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM host_observation_boots WHERE enrollment_key=?').get(key)?.count ?? 0);
        if (count >= 1024) throw new HostObservationError('boot_history_limit');
        this.store.db.prepare('INSERT INTO host_observation_boots(enrollment_key,boot_id) VALUES (?,?)').run(key, sample.bootId);
      }
      apply();
      const precise = hasPreciseDocker(sample);
      const payload = JSON.stringify(precise ? legacyHostSnapshot(sample) : sample);
      const extra = precise ? JSON.stringify(sample) : null;
      this.store.db.prepare(`INSERT INTO host_observation_state(enrollment_key,payload,digest,last_docker) VALUES (?,?,?,?)
        ON CONFLICT(enrollment_key) DO UPDATE SET payload=excluded.payload,digest=excluded.digest,last_docker=excluded.last_docker`).run(key, payload, digest, sample.docker.complete ? payload : row?.lastDocker ?? null);
      this.saveExtra(key, 'current', digest, extra);
      if (sample.docker.complete) this.saveExtra(key, 'docker', payloadHash(payload), extra);
      return 'accepted';
    });
  }
}
