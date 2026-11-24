import type { HostMetricsSnapshot } from './types.js';

export type OtlpMetricErrorCode = 'invalid_payload' | 'host_identity_mismatch' | 'future_observation' | 'metric_limit_exceeded';
export class OtlpMetricsError extends Error {
  constructor(readonly code: OtlpMetricErrorCode) { super(code); }
}

type JsonRecord = Record<string, unknown>;
const MAX_RESOURCE_METRICS = 8;
const MAX_SCOPE_METRICS = 10;
const MAX_METRICS = 64;
const MAX_DATA_POINTS = 512;
const MAX_ATTRIBUTES = 64;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);

function invalid(): never { throw new OtlpMetricsError('invalid_payload'); }
function textAttribute(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.value)) return undefined;
  return typeof value.value.stringValue === 'string' && value.value.stringValue.length <= 512 ? value.value.stringValue : undefined;
}
function attributes(value: unknown): Record<string, string> {
  if (!Array.isArray(value) || value.length > MAX_ATTRIBUTES) invalid();
  const result: Record<string, string> = {};
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== 'string' || item.key.length > 128) invalid();
    const found = textAttribute(item);
    if (found !== undefined) result[item.key] = found;
  }
  return result;
}
function numberValue(point: JsonRecord): number {
  const value = typeof point.asDouble === 'number'
    ? point.asDouble
    : typeof point.asInt === 'string' && /^-?\d{1,20}$/.test(point.asInt)
      ? Number(point.asInt)
      : typeof point.asInt === 'number' && Number.isSafeInteger(point.asInt)
        ? point.asInt
        : Number.NaN;
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid();
  return value;
}
function observationTime(point: JsonRecord, now: number): string {
  if (typeof point.timeUnixNano !== 'string' || !/^\d{1,24}$/.test(point.timeUnixNano)) invalid();
  let milliseconds: number;
  try { milliseconds = Number(BigInt(point.timeUnixNano) / 1_000_000n); } catch { return invalid(); }
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) invalid();
  if (milliseconds > now + MAX_FUTURE_SKEW_MS) throw new OtlpMetricsError('future_observation');
  return new Date(milliseconds).toISOString();
}
type Point = { value: number; attributes: Record<string, string>; observedAt: string };
function dataPoints(metric: JsonRecord, now: number): Point[] {
  const container = isRecord(metric.gauge) ? metric.gauge : isRecord(metric.sum) ? metric.sum : undefined;
  if (!container || !Array.isArray(container.dataPoints)) invalid();
  return container.dataPoints.map(value => {
    if (!isRecord(value)) invalid();
    return { value: numberValue(value), attributes: attributes(value.attributes ?? []), observedAt: observationTime(value, now) };
  });
}
function countDataPoints(metric: JsonRecord, count: { value: number }): void {
  for (const name of ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary']) {
    const aggregation = metric[name];
    if (!isRecord(aggregation) || !Array.isArray(aggregation.dataPoints)) continue;
    count.value += aggregation.dataPoints.length;
    if (count.value > MAX_DATA_POINTS) throw new OtlpMetricsError('metric_limit_exceeded');
  }
}
function ratio(value: number): number {
  if (value < 0 || value > 1.000001) invalid();
  return Math.min(1, value);
}
function latest(points: Point[]): string {
  if (!points.length) invalid();
  return new Date(Math.max(...points.map(point => Date.parse(point.observedAt)))).toISOString();
}
function normalizedDirection(value: string | undefined): 'receive' | 'transmit' | undefined {
  if (value === 'receive' || value === 'received' || value === 'rx' || value === 'in') return 'receive';
  if (value === 'transmit' || value === 'sent' || value === 'tx' || value === 'out') return 'transmit';
  return undefined;
}

export function parseOtlpMetrics(body: unknown, expectedHostId: string, now = Date.now()): HostMetricsSnapshot {
  if (!isRecord(body) || !Array.isArray(body.resourceMetrics) || !body.resourceMetrics.length) invalid();
  if (body.resourceMetrics.length > MAX_RESOURCE_METRICS) throw new OtlpMetricsError('metric_limit_exceeded');

  const count = { value: 0 }, found = new Map<string, Point[]>();
  let metricCount = 0;
  for (const resourceMetrics of body.resourceMetrics) {
    if (!isRecord(resourceMetrics) || !isRecord(resourceMetrics.resource) || !Array.isArray(resourceMetrics.scopeMetrics)
      || resourceMetrics.scopeMetrics.length > MAX_SCOPE_METRICS) invalid();
    const resourceAttributes = attributes(resourceMetrics.resource.attributes ?? []);
    if (resourceAttributes['host.id'] !== expectedHostId) throw new OtlpMetricsError('host_identity_mismatch');
    for (const scope of resourceMetrics.scopeMetrics) {
      if (!isRecord(scope) || !Array.isArray(scope.metrics)) invalid();
      metricCount += scope.metrics.length;
      if (metricCount > MAX_METRICS) throw new OtlpMetricsError('metric_limit_exceeded');
      for (const rawMetric of scope.metrics) {
        if (!isRecord(rawMetric) || typeof rawMetric.name !== 'string' || rawMetric.name.length > 160) invalid();
        countDataPoints(rawMetric, count);
        if (!['system.cpu.utilization','system.memory.utilization','system.memory.usage','system.memory.limit','system.filesystem.utilization','system.network.io'].includes(rawMetric.name)) continue;
        found.set(rawMetric.name, [...(found.get(rawMetric.name) ?? []), ...dataPoints(rawMetric, now)]);
      }
    }
  }

  let cpu: HostMetricsSnapshot['cpu'];
  const cpuPoints = found.get('system.cpu.utilization') ?? [];
  if (cpuPoints.length) {
    const byCpu = new Map<string, number>();
    for (const point of cpuPoints) {
      const group = point.attributes.cpu ?? point.attributes['cpu.id'] ?? 'all';
      const value = ratio(point.value);
      if (point.attributes.state !== 'idle') byCpu.set(group, (byCpu.get(group) ?? 0) + value);
    }
    cpu = { percent: Math.round([...byCpu.values()].reduce((total, value) => total + Math.min(1, value), 0) / Math.max(1, byCpu.size) * 1000) / 10, observedAt: latest(cpuPoints) };
  }

  const memoryUtilization = found.get('system.memory.utilization') ?? [];
  const memoryUsage = found.get('system.memory.usage') ?? [];
  const memoryLimit = found.get('system.memory.limit') ?? [];
  let memory: HostMetricsSnapshot['memory'];
  if (memoryUtilization.length || memoryUsage.length || memoryLimit.length) {
    const usedPoints = memoryUsage.filter(point => point.attributes.state === 'used');
    const usedBytes = usedPoints.length ? Math.round(usedPoints.reduce((sum, point) => sum + point.value, 0)) : null;
    const totalBytes = memoryLimit.length
      ? Math.round(memoryLimit.reduce((sum, point) => sum + point.value, 0))
      : memoryUsage.length ? Math.round(memoryUsage.reduce((sum, point) => sum + point.value, 0)) : null;
    const utilizationPoints = memoryUtilization.filter(point => !point.attributes.state || point.attributes.state === 'used');
    const utilization = utilizationPoints.length
      ? utilizationPoints.reduce((sum, point) => sum + ratio(point.value), 0) / utilizationPoints.length
      : usedBytes !== null && totalBytes ? usedBytes / totalBytes : null;
    const allMemoryPoints = [...memoryUtilization, ...memoryUsage, ...memoryLimit];
    memory = { usedBytes, totalBytes, utilizationPercent: utilization === null ? null : Math.round(ratio(utilization) * 1000) / 10, observedAt: latest(allMemoryPoints) };
  }

  const filesystemPoints = found.get('system.filesystem.utilization') ?? [];
  const filesystemMap = new Map<string, NonNullable<HostMetricsSnapshot['filesystems']>[number]>();
  for (const point of filesystemPoints) {
    const device = point.attributes.device ?? 'unknown';
    const mountpoint = point.attributes.mountpoint ?? point.attributes.mount_point ?? 'unknown';
    if (device.length > 200 || mountpoint.length > 200) invalid();
    filesystemMap.set(`${device}\0${mountpoint}`, { device, mountpoint, utilizationPercent: Math.round(ratio(point.value) * 1000) / 10, observedAt: point.observedAt });
  }
  if (filesystemMap.size > 32) throw new OtlpMetricsError('metric_limit_exceeded');

  const networkPoints = found.get('system.network.io') ?? [];
  const networkMap = new Map<string, { device: string; receivedBytes: number | null; sentBytes: number | null; observedAt: string }>();
  for (const point of networkPoints) {
    const device = point.attributes.device ?? 'unknown', direction = normalizedDirection(point.attributes.direction);
    if (!direction || point.value < 0 || !Number.isSafeInteger(point.value) || device.length > 200) continue;
    const current = networkMap.get(device) ?? { device, receivedBytes: null, sentBytes: null, observedAt: point.observedAt };
    if (direction === 'receive') current.receivedBytes = point.value;
    else current.sentBytes = point.value;
    if (Date.parse(point.observedAt) < Date.parse(current.observedAt)) current.observedAt = point.observedAt;
    networkMap.set(device, current);
  }
  if (networkMap.size > 32) throw new OtlpMetricsError('metric_limit_exceeded');
  if (!cpu && !memory && !filesystemMap.size && !networkMap.size) invalid();
  return {
    ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}),
    ...(filesystemMap.size ? { filesystems: [...filesystemMap.values()] } : {}),
    ...(networkMap.size ? { network: [...networkMap.values()] } : {})
  };
}
