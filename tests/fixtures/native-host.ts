import type { HostSnapshot } from '../../server/host-observation-schema.js';
import type { TrustedFileIO, TrustedStat } from '../../server/host-observation.js';
export const HOST_PIN = 'a'.repeat(64);
export const CHILD_ID = 'b'.repeat(64);
export const ROOT_DIRECTORY = '/run/infra-control-host-observations';
export function nativeSample(at: number, sequence = 1, cpu: number | null = 20, memory = 20, disk = 20): HostSnapshot {
  const stamp = new Date(at).toISOString();
  return { schemaVersion: 1, fingerprint: HOST_PIN, bootId: '12345678-1234-4234-8234-123456789012', sequence, startedAt: stamp, completedAt: stamp,
    host: { observedAt: stamp, status: 'complete', errors: [], cpu: cpu === null ? null : { percent: cpu, observedAt: stamp }, memory: { totalBytes: 10000, availableBytes: 10000 - memory * 100, observedAt: stamp }, rootfs: { totalBytes: 10000, freeBytes: 10000 - disk * 100, availableBytes: 10000 - disk * 100, observedAt: stamp } },
    docker: { startedAt: stamp, observedAt: stamp, complete: true, errors: [], containers: [{ id: CHILD_ID, name: 'private-worker', image: 'worker:1', status: 'running', healthStatus: null, startedAt: new Date(at - 60000).toISOString(), finishedAt: null, restartCount: 0, labels: {} }] }
  };
}
export function trustedFixture(sample: HostSnapshot) {
  let data = Buffer.from(JSON.stringify(sample)), revision = 1, unavailable = false, reads = 0;
  let beforeOpen: (() => Promise<void>) | undefined;
  const directory: TrustedStat = { kind: 'directory', uid: 0, gid: 0, mode: 0o755, size: 0, dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1, nlink: 1 };
  const metadata = (): TrustedStat => ({ ...directory, kind: 'file', gid: 1000, mode: 0o640, ino: 2, size: data.length, mtimeMs: revision, ctimeMs: revision });
  const io: TrustedFileIO = {
    lstat: async path => {
      if (unavailable) throw new Error('private-path-must-not-leak');
      if (path.endsWith('/snapshot.json')) return metadata();
      return path === ROOT_DIRECTORY ? { ...directory, gid: 1000, mode: 0o750 } : { ...directory };
    },
    open: async () => {
      reads++; if (beforeOpen) await beforeOpen();
      const captured = Buffer.from(data), stat = metadata();
      return { stat: async () => ({ ...stat }), close: async () => {}, read: async (buffer, offset, length, position) => {
        const bytesRead = Math.max(0, Math.min(length, captured.length - position)); captured.copy(buffer, offset, position, position + bytesRead); return { bytesRead };
      } };
    }
  };
  return { io, reads: () => reads, set: (value: HostSnapshot) => { data = Buffer.from(JSON.stringify(value)); revision++; }, missing: (value: boolean) => { unavailable = value; }, pause: (value: (() => Promise<void>) | undefined) => { beforeOpen = value; } };
}
