import { CatalogRepository, type CatalogSnapshot, type CatalogResourceRecord } from './catalog.js';
import type { AwsCatalogDiscovery } from './aws-discovery.js';

const COOLIFY_INTERVAL_MS = 120_000;
const AWS_INTERVAL_MS = 900_000;
const SCHEDULER_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;

type CoolifyRow = { uuid?: unknown; name?: unknown; type?: unknown; status?: unknown };
type Fetcher = typeof fetch;
function bounded(value: unknown, fallback: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value.trim();
}
function safeErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'access_denied';
  if (status === 429) return 'throttled';
  if (status === 404) return 'endpoint_not_found';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_http_error';
}

export class CoolifyCatalogDiscovery {
  private readonly origin: string;
  private cooldownUntil = 0;
  private failures = 0;
  constructor(
    private readonly catalog: CatalogRepository,
    private readonly connectionId: string,
    url: string,
    private readonly token: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now
  ) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid Coolify API URL');
    this.origin = parsed.origin;
  }

  async scan(): Promise<{ resources: CatalogResourceRecord[]; failures: number }> {
    const observedAt = new Date(this.now()).toISOString();
    if(this.cooldownUntil>this.now())return {resources:this.catalog.listResources().filter(item=>item.provider==='coolify'),failures:1};
    let rows: unknown;
    try {
      const response = await this.fetcher(`${this.origin}/api/v1/resources`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) {
        this.cooldownUntil=this.now()+this.retryDelay(response);
        this.catalog.reconcileScope(this.connectionId, 'coolify:resources', [], { complete: false, observedAt, state: 'failed', errorCode: safeErrorCode(response.status) });
        return { resources: this.catalog.listResources().filter(item => item.provider === 'coolify'), failures: 1 };
      }
      rows = await response.json();
    } catch (error) {
      const code = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'provider_error';
      this.cooldownUntil=this.now()+this.retryDelay();
      this.catalog.reconcileScope(this.connectionId, 'coolify:resources', [], { complete: false, observedAt, state: 'failed', errorCode: code });
      return { resources: this.catalog.listResources().filter(item => item.provider === 'coolify'), failures: 1 };
    }

    if (!Array.isArray(rows)) {
      this.cooldownUntil=this.now()+this.retryDelay();
      this.catalog.reconcileScope(this.connectionId, 'coolify:resources', [], { complete: false, observedAt, state: 'partial', errorCode: 'invalid_response' });
      return { resources: this.catalog.listResources().filter(item => item.provider === 'coolify'), failures: 1 };
    }
    const snapshots: CatalogSnapshot[] = [];
    for (const value of rows as CoolifyRow[]) {
      if (!value || typeof value !== 'object' || typeof value.uuid !== 'string' || !value.uuid.trim() || value.uuid.length > 200) {
        this.cooldownUntil=this.now()+this.retryDelay();
        this.catalog.reconcileScope(this.connectionId, 'coolify:resources', [], { complete: false, observedAt, state: 'partial', errorCode: 'invalid_response' });
        return { resources: this.catalog.listResources().filter(item => item.provider === 'coolify'), failures: 1 };
      }
      const uuid = bounded(value.uuid, '', 200);
      if (!uuid) {
        this.cooldownUntil=this.now()+this.retryDelay();
        this.catalog.reconcileScope(this.connectionId, 'coolify:resources', [], { complete: false, observedAt, state: 'partial', errorCode: 'invalid_response' });
        return { resources: this.catalog.listResources().filter(item => item.provider === 'coolify'), failures: 1 };
      }
      const type = bounded(value.type, 'resource', 100);
      snapshots.push({
        providerId: uuid, resourceType: type, region: 'vps', name: bounded(value.name, uuid),
        state: bounded(value.status, 'unknown', 80), detail: type, observedAt,
        aliases: [`coolify:${uuid}`]
      });
    }
    this.failures=0;this.cooldownUntil=0;
    this.catalog.reconcileScope(this.connectionId, 'coolify:resources', snapshots, { complete: true, observedAt });
    return { resources: this.catalog.listResources().filter(item => item.provider === 'coolify'), failures: 0 };
  }

  private retryDelay(response?:Response):number {
    const header=response?.headers.get('Retry-After');
    const parsed=header&&/^\d+$/.test(header)?Number(header)*1000:header?Date.parse(header)-this.now():NaN;
    this.failures++;
    const fallback=Math.min(30*60_000,COOLIFY_INTERVAL_MS*2**Math.min(this.failures-1,4));
    return Math.max(1_000,Math.min(6*60*60_000,Number.isFinite(parsed)&&parsed>=0?parsed:fallback));
  }
}

type Discovery = { scan(): Promise<{ resources: CatalogResourceRecord[]; failures: number }> };
export class CatalogDiscoveryScheduler {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private closed = false;
  private lastAwsAttempt = Number.NEGATIVE_INFINITY;
  private lastCoolifyAttempt = Number.NEGATIVE_INFINITY;

  constructor(private readonly aws: Discovery, private readonly coolify: Discovery | undefined, private readonly now: () => number = Date.now) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, SCHEDULER_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    const now = this.now();
    const tasks: Promise<unknown>[] = [];
    if (now - this.lastAwsAttempt >= AWS_INTERVAL_MS) {
      this.lastAwsAttempt = now;
      tasks.push(this.aws.scan());
    }
    if (this.coolify && now - this.lastCoolifyAttempt >= COOLIFY_INTERVAL_MS) {
      this.lastCoolifyAttempt = now;
      tasks.push(this.coolify.scan());
    }
    this.pending = Promise.allSettled(tasks).then(() => undefined).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
