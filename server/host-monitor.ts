import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { HostObservationConfig, Resource } from './types.js';
import { HOST_TTL_MS, HOST_CADENCE_MS, type HostSnapshot } from './host-observation-schema.js';

type Component = 'host-cpu' | 'host-memory' | 'host-disk' | 'docker-health' | 'host-availability';
type Evidence = { value: 'bad' | 'good' | 'band'; at: string };
type Identity = { id: string; name: string; catalogId: string };
type Lane = { resource: Identity; component: Component; bootId: string; lastAt: string | null; bad: number; good: number; active: boolean; uncertain: boolean; obligationVersion?: number };
type Saved = { key: string; data: string };

/** Reads only the native DTO projection. No provider clients, Costs or network IO. */
export class NativeHostMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private running = false;
  lastErrorCode: string | null = null;
  constructor(private readonly store: Store, private readonly configuration: () => readonly HostObservationConfig[], private readonly resources: (samples: ReadonlyMap<string, HostSnapshot | undefined>, includeRetiredDocker: (resourceId: string) => boolean, completeDocker: ReadonlyMap<string, HostSnapshot>) => readonly Resource[], private readonly now: () => number = Date.now) {
    store.db.exec('CREATE TABLE IF NOT EXISTS host_monitor_lanes(lane_key TEXT PRIMARY KEY,data TEXT NOT NULL)');
  }
  private event(lane: Lane, status: 'open' | 'unknown' | 'resolved' | 'information', reason: string, at: string | null): void {
    const payload = {
      source: 'host-native-monitor', category: 'infrastructure', component: lane.component,
      kind: lane.component === 'docker-health' ? 'application' : lane.component === 'host-availability' ? 'availability' : 'observability',
      resourceId: lane.resource.id, catalogId: lane.resource.catalogId, resourceName: lane.resource.name,
      status, actionable: status === 'open', transitionReason: reason, reasonCode: reason,
      observedAt: at, from: lane.uncertain ? 'unknown' : lane.active ? 'bad' : 'normal', to: status === 'open' ? 'bad' : status === 'resolved' ? 'normal' : status
    };
    const transition = [lane.resource.id, lane.component, status, reason, at];
    const dedup = createHash('sha256').update(JSON.stringify(lane.obligationVersion === undefined
      ? transition : [...transition, lane.obligationVersion])).digest('hex');
    this.store.appendEventOnce(`host-monitor-v1:${dedup}`, 'incident', lane.resource.id, payload);
  }
  private unknown(lane: Lane, reason: string): void {
    if (lane.active && !lane.uncertain) this.event(lane, 'unknown', reason, lane.lastAt);
    lane.uncertain = lane.active;
    lane.bad = 0; lane.good = 0;
  }
  private disable(lane: Lane): void {
    if (lane.active) this.event(lane, 'information', 'host_monitor_obligation_removed', lane.lastAt);
  }
  private advance(lane: Lane, evidence: Evidence | undefined, bootId: string, required: number): void {
    const changedBoot = Boolean(lane.bootId && lane.bootId !== bootId);
    lane.bootId = bootId;
    if (changedBoot) {
      this.unknown(lane, 'host_boot_changed');
      lane.lastAt = null;
    }
    const at = evidence ? Date.parse(evidence.at) : NaN;
    const fresh = Number.isFinite(at) && this.now() - at >= -5000 && this.now() - at < HOST_TTL_MS;
    if (!evidence || !fresh) { this.unknown(lane, 'host_signal_unknown'); return; }
    const previousAt = lane.lastAt ? Date.parse(lane.lastAt) : NaN;
    if (Number.isFinite(previousAt) && at - previousAt >= HOST_TTL_MS) this.unknown(lane, 'host_observation_gap');
    if (Number.isFinite(previousAt) && at <= previousAt) return;
    lane.lastAt = evidence.at;
    lane.bad = evidence.value === 'bad' ? Math.min(required, lane.bad + 1) : 0;
    lane.good = evidence.value === 'good' ? Math.min(required, lane.good + 1) : 0;
    if (lane.bad >= required && (!lane.active || lane.uncertain)) {
      this.event(lane, 'open', lane.component === 'docker-health' ? 'docker_health_unhealthy' : lane.component === 'host-availability' ? 'host_availability_requirement_failed' : 'host_threshold_exceeded', evidence.at);
      lane.active = true; lane.uncertain = false;
    } else if (lane.good >= required && lane.active) {
      // A gap cannot prove when or whether the earlier incident recovered.
      this.event(lane, lane.uncertain ? 'information' : 'resolved', lane.uncertain ? 'host_baseline_reestablished' : lane.component === 'docker-health' ? 'docker_health_recovered' : lane.component === 'host-availability' ? 'host_availability_requirement_restored' : 'host_threshold_cleared', evidence.at);
      lane.active = false; lane.uncertain = false;
    }
  }
  tick(): void {
    if (this.closed || this.running) return;
    this.running = true; this.lastErrorCode = null;
    try {
      const configs = new Map(this.configuration().filter(config => config.enabled).map(config => [config.key, config]));
      const byAccount = new Map<string, { config: HostObservationConfig; sample: HostSnapshot; docker: HostSnapshot | undefined; containers: ReadonlyMap<string, HostSnapshot['docker']['containers'][number]> }>();
      const samples = new Map<string, HostSnapshot | undefined>();
      const completeDocker = new Map<string, HostSnapshot>();
      for (const binding of this.store.hostObservations.enrollments()) {
        const config = configs.get(binding.key);
        if (!config || config.expectedFingerprint !== binding.fingerprint) continue;
        const sample = this.store.hostObservations.current(binding.key);
        samples.set(binding.accountId, sample);
        if (sample) {
          const docker = this.store.hostObservations.completeDockerForBoot(binding.key, sample);
          if (docker) completeDocker.set(binding.accountId, docker);
          const containers = new Map(docker?.docker.containers.map(item => [item.id, item] as const));
          byAccount.set(binding.accountId, { config, sample, docker, containers });
        }
      }
      const expectations = new Map<string, number | null>();
      const obligationVersion = (id: string): number | null => {
        const cached = expectations.get(id);
        if (cached !== undefined) return cached;
        const expectation = this.store.operational.expectation(id);
        const version = expectation.mode === 'always-on' ? expectation.version : null;
        expectations.set(id, version);
        return version;
      };
      const resources = this.resources(samples, id => obligationVersion(id) !== null, completeDocker).filter(resource => resource.catalog?.provider === 'host');
      this.store.atomic(() => {
        const saved = new Map(this.store.db.prepare('SELECT lane_key AS key,data FROM host_monitor_lanes').all().map(value => { const row = value as Saved; return [row.key, JSON.parse(row.data) as Lane] as const; }));
        const save = this.store.db.prepare('INSERT INTO host_monitor_lanes(lane_key,data) VALUES (?,?) ON CONFLICT(lane_key) DO UPDATE SET data=excluded.data WHERE data<>excluded.data');
        const remove = this.store.db.prepare('DELETE FROM host_monitor_lanes WHERE lane_key=?');
        const visit = (resource: Resource, component: Component, bootId: string, enabled: boolean, evidence: Evidence | undefined, count: number, version?: number) => {
          if (!enabled) return;
          const key = JSON.stringify([resource.id, component]);
          const identity = { id: resource.id, name: resource.name, catalogId: resource.catalog!.catalogId };
          let previous = saved.get(key);
          saved.delete(key);
          if (previous && previous.obligationVersion !== undefined && previous.obligationVersion !== version) {
            this.disable(previous);
            previous = undefined;
          }
          const lane: Lane = previous ?? { resource: identity, component, bootId, lastAt: null, bad: 0, good: 0, active: false, uncertain: false };
          if (version !== undefined) lane.obligationVersion = version;
          lane.resource = identity;
          this.advance(lane, evidence, bootId, count);
          save.run(key, JSON.stringify(lane));
        };
        const threshold = (value: number | null | undefined, at: string | undefined): Evidence | undefined => value !== null && value !== undefined && Number.isFinite(value) && at ? { value: value >= 90 ? 'bad' : value <= 85 ? 'good' : 'band', at } : undefined;
        for (const resource of resources) {
          const catalog = resource.catalog!;
          const context = byAccount.get(catalog.accountId);
          if (!context) continue;
          const { config, sample, docker, containers } = context;
          const isDocker = catalog.resourceType === 'docker-container';
          const container = isDocker ? containers.get(catalog.providerId) : undefined;
          const bootId = sample.bootId;
          const present = resource.health?.presence?.state === 'fresh' && (isDocker || resource.coverage?.state === 'healthy');
          const version = obligationVersion(resource.id);
          const individualAt = container ? container.observedAt ?? docker?.docker.observedAt : undefined;
          let availability: Evidence | undefined;
          if (present && resource.observedAt) {
            if (isDocker && container && individualAt === resource.observedAt) {
              availability = { value: container.status === 'running' ? 'good' : 'bad', at: individualAt };
            } else if (!isDocker && resource.state !== 'unknown') {
              availability = { value: resource.state === 'online' ? 'good' : 'bad', at: resource.observedAt };
            }
          } else if (version !== null && isDocker && catalog.lifecycle !== 'active' && docker && !container) {
            availability = { value: 'bad', at: docker.docker.observedAt };
          }
          visit(resource, 'host-availability', bootId, version !== null, availability, 1, version ?? undefined);
          if (catalog.lifecycle === 'retired') continue;
          if (resource.catalog!.resourceType === 'linux-host') {
            const enabled = config.monitoring?.enabled === true;
            const metric = resource.hostMetrics;
            visit(resource, 'host-cpu', sample.bootId, enabled, present ? threshold(metric?.cpu?.percent, metric?.cpu?.observedAt) : undefined, 3);
            visit(resource, 'host-memory', sample.bootId, enabled, present ? threshold(metric?.memory?.utilizationPercent, metric?.memory?.observedAt) : undefined, 3);
            const root = metric?.filesystems?.find(item => item.mountpoint === '/');
            visit(resource, 'host-disk', sample.bootId, enabled, present ? threshold(root?.utilizationPercent, root?.observedAt) : undefined, 2);
          } else {
            const signal = resource.health?.service;
            const evidence: Evidence | undefined = present && signal?.observedAt && signal.source === 'docker-health' && (signal.state === 'healthy' || signal.state === 'unhealthy')
              ? { value: signal.state === 'unhealthy' ? 'bad' : 'good', at: signal.observedAt } : undefined;
            visit(resource, 'docker-health', bootId, true, evidence, 1);
          }
        }
        for (const [key, lane] of saved) {
          this.disable(lane);
          remove.run(key);
        }
      });
    } catch { this.lastErrorCode = 'host_monitor_failed'; }
    finally { this.running = false; }
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.tick(); this.timer = setInterval(() => this.tick(), HOST_CADENCE_MS); this.timer.unref();
  }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
