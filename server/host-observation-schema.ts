import { z } from 'zod';
import type { HostMetricsSnapshot } from './types.js';

export const HOST_CADENCE_MS = 60_000;
export const HOST_TTL_MS = 180_000;
export const HOST_MAX_BYTES = 4 * 1024 * 1024;
export const HOST_MAX_WINDOW_MS = 25_000;
export class HostObservationError extends Error {
  constructor(readonly code: string) { super(code); }
}
export const safeHostError = (error: unknown): string => error instanceof HostObservationError ? error.code : 'source_unavailable';
const text = (max: number) => z.string().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f-\u009f]/.test(value));
const at = z.string().datetime({ precision: 3 });
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const errors = z.array(z.enum(['cpu_unavailable', 'memory_unavailable', 'filesystem_unavailable', 'docker_unavailable', 'docker_timeout', 'docker_output_limit', 'docker_invalid', 'docker_changed', 'docker_limit'])).max(9).refine(values => new Set(values).size === values.length);
const containerSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), name: text(200), image: text(200),
  status: z.enum(['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead']),
  healthStatus: z.enum(['starting', 'healthy', 'unhealthy']).nullable(),
  startedAt: at.nullable(), finishedAt: at.nullable(), restartCount: bytes,
  observedAt: at.optional(),
  labels: z.object({ 'com.docker.compose.project': text(160).optional(), 'com.docker.compose.service': text(160).optional() }).strict()
}).strict();
export const dockerObservationSchema = z.object({
  startedAt: at, observedAt: at, complete: z.boolean(), errors,
  containers: z.array(containerSchema).max(1000)
}).strict();
export const hostSnapshotSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  bootId: z.string().uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startedAt: at, completedAt: at,
  host: z.object({
    observedAt: at, status: z.enum(['complete', 'partial', 'failed']), errors,
    cpu: z.object({ percent: z.number().min(0).max(100), observedAt: at }).strict().nullable(),
    memory: z.object({ totalBytes: bytes.positive(), availableBytes: bytes, observedAt: at }).strict().nullable(),
    rootfs: z.object({ totalBytes: bytes.positive(), freeBytes: bytes, availableBytes: bytes, observedAt: at }).strict().nullable()
  }).strict(),
  docker: dockerObservationSchema
}).strict().superRefine((value, context) => {
  const fail = () => context.addIssue({ code: 'custom', message: 'inconsistent host observation' });
  const start = Date.parse(value.startedAt), end = Date.parse(value.completedAt);
  const inWindow = (stamp: string) => Date.parse(stamp) >= start && Date.parse(stamp) <= end;
  if (end < start || end - start > HOST_MAX_WINDOW_MS) fail();
  if (![value.host.observedAt, value.docker.startedAt, value.docker.observedAt].every(inWindow)) fail();
  if (Date.parse(value.docker.startedAt) > Date.parse(value.docker.observedAt)) fail();
  for (const metric of [value.host.cpu, value.host.memory, value.host.rootfs]) if (metric && (!inWindow(metric.observedAt) || Date.parse(metric.observedAt) > Date.parse(value.host.observedAt))) fail();
  if (value.host.memory && value.host.memory.availableBytes > value.host.memory.totalBytes) fail();
  if (value.host.rootfs && (value.host.rootfs.freeBytes > value.host.rootfs.totalBytes || value.host.rootfs.availableBytes > value.host.rootfs.freeBytes)) fail();
  if (!value.host.memory && !value.host.errors.includes('memory_unavailable')) fail();
  if (!value.host.rootfs && !value.host.errors.includes('filesystem_unavailable')) fail();
  if (value.host.errors.some(code => code.startsWith('docker_')) || value.docker.errors.some(code => !code.startsWith('docker_'))) fail();
  const status = value.host.memory && value.host.rootfs && value.host.errors.length === 0 ? 'complete' : !value.host.cpu && !value.host.memory && !value.host.rootfs ? 'failed' : 'partial';
  if (value.host.status !== status || value.docker.complete !== (value.docker.errors.length === 0)) fail();
  if (new Set(value.docker.containers.map(item => item.id)).size !== value.docker.containers.length) fail();
  for (const item of value.docker.containers) {
    if (value.schemaVersion === 2 && item.observedAt === undefined) fail();
    const observed = Date.parse(item.observedAt ?? value.docker.observedAt);
    if (observed < Date.parse(value.docker.startedAt) || observed > Date.parse(value.docker.observedAt)) fail();
    if (item.startedAt && Date.parse(item.startedAt) > observed || item.finishedAt && Date.parse(item.finishedAt) > observed) fail();
  }
});
export type HostSnapshot = z.infer<typeof hostSnapshotSchema>;
export type DockerObservation = z.infer<typeof dockerObservationSchema>;

// También lee el v1 transitorio que ya podía contener timestamps por lote.
export function legacyHostSnapshot(sample: HostSnapshot): HostSnapshot {
  return { ...sample, schemaVersion: 1, docker: { ...sample.docker,
    containers: sample.docker.containers.map(({ observedAt: _batchTime, ...container }) => container)
  } };
}
export function decodeHostSnapshot(input: Uint8Array, fingerprint: string, now: number): HostSnapshot {
  if (input.byteLength > HOST_MAX_BYTES) throw new HostObservationError('snapshot_too_large');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)); }
  catch { throw new HostObservationError('snapshot_invalid'); }
  const parsed = hostSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new HostObservationError('snapshot_invalid');
  const sample = parsed.data;
  if (sample.fingerprint !== fingerprint) throw new HostObservationError('fingerprint_mismatch');
  if (!Number.isFinite(now) || Date.parse(sample.completedAt) > now + 5000) throw new HostObservationError('snapshot_future');
  if (now - Date.parse(sample.completedAt) >= HOST_TTL_MS) throw new HostObservationError('snapshot_expired');
  return sample;
}
export function nativeHostMetrics(sample: HostSnapshot): HostMetricsSnapshot {
  const result: HostMetricsSnapshot = {};
  if (sample.host.cpu) result.cpu = { ...sample.host.cpu };
  const memory = sample.host.memory;
  if (memory) result.memory = { totalBytes: memory.totalBytes, usedBytes: memory.totalBytes - memory.availableBytes, utilizationPercent: 100 * (memory.totalBytes - memory.availableBytes) / memory.totalBytes, observedAt: memory.observedAt };
  const fs = sample.host.rootfs;
  if (fs) {
    const used = fs.totalBytes - fs.freeBytes;
    const usable = used + fs.availableBytes;
    if (usable > 0) result.filesystems = [{ device: 'rootfs', mountpoint: '/', utilizationPercent: 100 * used / usable, observedAt: fs.observedAt }];
  }
  return result;
}
