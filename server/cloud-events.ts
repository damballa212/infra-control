import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { tokenHash } from './auth.js';
import type { CatalogRepository } from './catalog.js';
import type { PendingCloudEvent, Store } from './store.js';
import type { AwsAccount } from './types.js';
import { isAwsAccountEnabled } from './aws-credentials.js';

const eventBody = z.object({
  id: z.string().min(1).max(128),
  source: z.literal('aws.ec2'),
  'detail-type': z.literal('EC2 Instance State-change Notification'),
  account: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/),
  time: z.string().datetime({ offset: true }),
  detail: z.object({
    'instance-id': z.string().regex(/^i-[a-z0-9]{8,32}$/),
    state: z.enum(['pending', 'running', 'shutting-down', 'terminated', 'stopping', 'stopped'])
  })
}).passthrough();
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export class CloudEventError extends Error {
  constructor(readonly statusCode: number, readonly safeMessage: string) { super(safeMessage); }
}
export type AwsStateEvent = z.infer<typeof eventBody>;
type AppliedEvent = { resource?: ReturnType<CatalogRepository['listResources']>[number]; previousState: string | null; eventId: string };

export class AwsCloudEventIngest {
  private draining?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private closed = false;
  constructor(
    private readonly store: Store,
    private readonly catalog: CatalogRepository,
    private readonly accounts: AwsAccount[],
    private readonly accountTokenHashes: Record<string, string> | undefined,
    private readonly onApplied?: (event: AppliedEvent) => void,
    private readonly now: () => number = Date.now
  ) {}

  accept(credential: string | undefined, input: unknown): { status: 'accepted' | 'duplicate'; eventKey: string } {
    const parsed = eventBody.safeParse(input);
    if (!parsed.success) throw new CloudEventError(400, 'Evento EC2 no válido.');
    const event = parsed.data, token = credential && /^[A-Za-z0-9._~-]{32,256}$/.test(credential) ? credential : '';
    const expected = this.accountTokenHashes?.[event.account];
    const actualHash = tokenHash(token);
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected) || actualHash.length !== expected.length || !timingSafeEqual(Buffer.from(actualHash), Buffer.from(expected.toLowerCase()))) {
      throw new CloudEventError(this.accountTokenHashes ? 401 : 503, this.accountTokenHashes ? 'Origen no autorizado.' : 'Ingesta de eventos no configurada.');
    }
    if (!this.accounts.some(account => account.accountId === event.account && isAwsAccountEnabled(account, this.accounts))) throw new CloudEventError(403, 'La cuenta del evento no está conectada.');
    const connection = this.catalog.connections().find(item => item.provider === 'aws' && item.providerAccountId === event.account && item.state === 'active');
    const allowedScope = connection && this.catalog.listScopes().some(scope => scope.connectionId === connection.id && scope.scopeKey === `aws:ec2:${event.region}` && scope.state === 'healthy' && scope.lastSuccessAt !== null);
    if (!allowedScope) throw new CloudEventError(503, 'La región todavía no tiene cobertura verificada. EventBridge puede reintentar después del barrido.');
    const eventTime = new Date(event.time).toISOString(), age = this.now() - Date.parse(eventTime);
    if (age > MAX_AGE_MS || age < -MAX_FUTURE_SKEW_MS) throw new CloudEventError(400, 'La fecha del evento está fuera de la ventana permitida.');
    const eventKey = `${event.account}:${event.id}`;
    const result = this.store.enqueueCloudEvent({
      eventKey, accountId: event.account, region: event.region, instanceId: event.detail['instance-id'],
      state: event.detail.state, eventTime, receivedAt: new Date(this.now()).toISOString()
    });
    if (result === 'conflict') throw new CloudEventError(409, 'El identificador del evento ya se usó con otro contenido.');
    return { status: result === 'accepted' ? 'accepted' : 'duplicate', eventKey };
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      for (const event of this.store.pendingCloudEvents(100)) {
        if(this.closed)return;
        try {
          if (!this.accounts.some(account => account.accountId === event.accountId && isAwsAccountEnabled(account, this.accounts))) {
            this.store.finishCloudEvent(event.eventKey, 'ignored', 'account_unavailable');
            continue;
          }
          const result = this.catalog.applyAwsStateEvent({
            accountId: event.accountId, region: event.region, instanceId: event.instanceId,
            state: event.state, eventTime: event.eventTime, eventId: event.eventKey
          });
          if (result.status === 'ignored') this.store.finishCloudEvent(event.eventKey, 'ignored', result.reasonCode);
          else {
            if (result.resource) this.onApplied?.({ resource: result.resource, previousState: result.previousState, eventId: event.eventKey });
            this.store.finishCloudEvent(event.eventKey, 'processed');
          }
        } catch {
          const attempts=this.store.retryCloudEvent(event.eventKey, 'processing_error');
          if(!this.retryTimer&&!this.closed){
            const delay=Math.min(300_000,5_000*2**Math.min(Math.max(0,attempts-1),6));
            this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;void this.drain();},delay);
            this.retryTimer.unref();
          }
        }
      }
    })().finally(() => {
      this.draining = undefined;
      if (!this.closed && !this.retryTimer && this.store.pendingCloudEvents(1).length) {
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.drain(); }, 25);
        this.retryTimer.unref();
      }
    });
    return this.draining;
  }

  resume(): void { void this.drain(); }
  close(): void { this.closed=true;if(this.retryTimer)clearTimeout(this.retryTimer);this.retryTimer=undefined; }
}

export type CloudEventInboxItem = PendingCloudEvent;
