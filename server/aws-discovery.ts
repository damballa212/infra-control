import { CatalogRepository, type CatalogResourceRecord } from './catalog.js';
import { EC2Client, DescribeInstancesCommand, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { AwsAccount } from './types.js';
import { awsCredentials, isAwsAccountEnabled } from './aws-credentials.js';

export type AwsDiscoveredInstance = {
  InstanceId?: string; InstanceType?: string; State?: { Name?: string }; StateTransitionReason?: string;
  Tags?: Array<{ Key?: string; Value?: string }>;
};
export type AwsDiscoveryIO = {
  identity(account: AwsAccount, accounts?: readonly AwsAccount[]): Promise<string>;
  regions(account: AwsAccount, accounts?: readonly AwsAccount[]): Promise<{ regions: string[] }>;
  instances(account: AwsAccount, region: string, nextToken?: string, accounts?: readonly AwsAccount[]): Promise<{ instances: AwsDiscoveredInstance[]; nextToken?: string }>;
  now(): number;
};
const PAGE_LIMIT = 100;
const MAX_CONCURRENT_ACCOUNTS = 2;
const MAX_CONCURRENT_REGIONS = 2;
const REGIONS_CACHE_MS = 24 * 60 * 60 * 1000;
const awsTransport: AwsDiscoveryIO = {
  identity: async (account, accounts) => {
    const client = new STSClient({ region: 'us-east-1', credentials: awsCredentials(account, accounts), maxAttempts: 1, requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 } });
    try { return (await client.send(new GetCallerIdentityCommand({}))).Account ?? ''; }
    finally { client.destroy(); }
  },
  regions: async (account, accounts) => {
    const client = new EC2Client({ region: 'us-east-1', credentials: awsCredentials(account, accounts), maxAttempts: 1, requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 } });
    try {
      const result = await client.send(new DescribeRegionsCommand({ AllRegions: false }));
      return { regions: (result.Regions ?? []).map(item => item.RegionName ?? '').filter(Boolean) };
    } finally { client.destroy(); }
  },
  instances: async (account, region, nextToken, accounts) => {
    const client = new EC2Client({ region, credentials: awsCredentials(account, accounts), maxAttempts: 1, requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 } });
    try {
      const result = await client.send(new DescribeInstancesCommand({ MaxResults: 1000, ...(nextToken ? { NextToken: nextToken } : {}) }));
      return { instances: result.Reservations?.flatMap(reservation => reservation.Instances ?? []) ?? [], ...(result.NextToken ? { nextToken: result.NextToken } : {}) };
    } finally { client.destroy(); }
  },
  now: () => Date.now()
};
class DiscoveryFailure extends Error {
  constructor(readonly safeCode: string, readonly state: 'partial' | 'failed' = 'failed') { super(safeCode); }
}
function failureOf(error: unknown): { code: string; state: 'partial' | 'failed' } {
  if (error instanceof DiscoveryFailure) return { code: error.safeCode, state: error.state };
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  if (name.includes('throttl') || name.includes('requestlimit')) return { code: 'throttled', state: 'failed' };
  if (name.includes('accessdenied') || name.includes('unauthorized') || name.includes('forbidden')) return { code: 'access_denied', state: 'failed' };
  if (name.includes('credential')) return { code: 'credentials_unavailable', state: 'failed' };
  if (name.includes('timeout') || name.includes('abort')) return { code: 'timeout', state: 'failed' };
  return { code: 'provider_error', state: 'failed' };
}
async function mapLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await task(current!);
    }
  }));
}
function transitionTime(reason: string | undefined): string | null {
  if (!reason) return null;
  const value = reason.match(/\(([^()]*)\)\s*$/)?.[1];
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function serializeInstance(instance: AwsDiscoveredInstance, account: AwsAccount, region: string, observedAt: string) {
  const providerId = instance.InstanceId;
  if (!providerId) throw new DiscoveryFailure('invalid_provider_resource', 'partial');
  const tags = Object.fromEntries((instance.Tags ?? []).filter(tag => tag.Key && tag.Value).map(tag => [tag.Key!, tag.Value!]));
  const legacy = account.instances?.some(item => item.id === providerId && item.region === region);
  return {
    providerId, resourceType: 'ec2-instance', region, name: tags.Name?.trim() || providerId,
    state: instance.State?.Name ?? 'unknown', detail: instance.InstanceType ?? 'Tipo sin informar', observedAt,
    stateChangedAt: transitionTime(instance.StateTransitionReason), tags,
    aliases: [`aws:${account.accountId}:${region}:${providerId}`, ...(legacy ? [`aws:${account.name}:${providerId}`] : [])]
  };
}
export class AwsCatalogDiscovery {
  private regionCache = new Map<string, { regions: string[]; expiresAt: number }>();
  constructor(private readonly catalog: CatalogRepository, private readonly accounts: AwsAccount[], private readonly io: AwsDiscoveryIO = awsTransport) {}

  async scan(): Promise<{ resources: CatalogResourceRecord[]; failures: number }> {
    const accounts = new Map<string, AwsAccount>();
    for (const account of this.accounts) {
      const connection = this.catalog.registerConnection({ provider: 'aws', providerAccountId: account.accountId, name: account.name, displayName: account.displayName, credentialRef: `server-config:aws/${account.name}` });
      const enabled = isAwsAccountEnabled(account, this.accounts);
      this.catalog.setConnectionState(connection.id, enabled ? 'active' : 'suspended');
      if (enabled && !accounts.has(account.accountId)) accounts.set(account.accountId, account);
    }
    let failures = 0;
    await mapLimit([...accounts.values()], MAX_CONCURRENT_ACCOUNTS, async account => {
      const connection = this.catalog.connectionByAlias('aws', account.name)
        ?? this.catalog.registerConnection({ provider: 'aws', providerAccountId: account.accountId, name: account.name, displayName: account.displayName, credentialRef: `server-config:aws/${account.name}` });
      const observedAt = new Date(this.io.now()).toISOString();
      try {
        if (!isAwsAccountEnabled(account, this.accounts)) return;
        const actualAccountId = await this.io.identity(account, this.accounts);
        if (actualAccountId !== connection.providerAccountId) throw new DiscoveryFailure('account_mismatch');
        this.catalog.reconcileScope(connection.id, 'aws:identity', [], { complete: true, observedAt });
      } catch (error) {
        const { code, state } = failureOf(error);
        this.catalog.reconcileScope(connection.id, 'aws:identity', [], { complete: false, observedAt, errorCode: code, state });
        failures++;
        return;
      }

      let regions: string[];
      try {
        regions = await this.regions(account);
        if (regions.length === 0) throw new DiscoveryFailure('no_enabled_regions', 'partial');
        this.catalog.reconcileScope(connection.id, 'aws:regions', [], { complete: true, observedAt });
      } catch (error) {
        const { code, state } = failureOf(error);
        this.catalog.reconcileScope(connection.id, 'aws:regions', [], { complete: false, observedAt, errorCode: code, state });
        failures++;
        // An unavailable region directory does not revoke independently readable
        // scopes. Keep its failure visible and scan only regions already known.
        regions = this.knownRegions(account, connection.id);
        if (regions.length === 0) return;
      }

      await mapLimit(regions, MAX_CONCURRENT_REGIONS, async region => {
        const scopeKey = `aws:ec2:${region}`;
        try {
          const instances = await this.instances(account, region);
          const snapshots = instances.map(instance => serializeInstance(instance, account, region, observedAt));
          this.catalog.reconcileScope(connection.id, scopeKey, snapshots, { complete: true, observedAt });
        } catch (error) {
          const { code, state } = failureOf(error);
          this.catalog.reconcileScope(connection.id, scopeKey, [], { complete: false, observedAt, errorCode: code, state });
          failures++;
        }
      });
    });
    const active = new Set(this.catalog.connections().filter(connection => connection.state === 'active').map(connection => connection.id));
    return { resources: this.catalog.listResources().filter(item => item.provider === 'aws' && active.has(item.connectionId)), failures };
  }

  private async regions(account: AwsAccount): Promise<string[]> {
    const cached = this.regionCache.get(account.accountId);
    if (cached && cached.expiresAt > this.io.now()) return cached.regions;
    if (!isAwsAccountEnabled(account, this.accounts)) throw new DiscoveryFailure('connection_suspended');
    const page = await this.io.regions(account, this.accounts);
    const regions = [...new Set(page.regions)].sort();
    this.regionCache.set(account.accountId, { regions, expiresAt: this.io.now() + REGIONS_CACHE_MS });
    return regions;
  }

  private knownRegions(account: AwsAccount, connectionId: string): string[] {
    const scopes=this.catalog.listScopes().filter(scope=>scope.connectionId===connectionId&&scope.scopeKey.startsWith('aws:ec2:'));
    const resources=this.catalog.listResources({includeRetired:true}).filter(resource=>resource.connectionId===connectionId);
    return [...new Set([
      ...(this.regionCache.get(account.accountId)?.regions??[]),
      ...(account.instances??[]).map(instance=>instance.region),
      ...scopes.map(scope=>scope.scopeKey.slice('aws:ec2:'.length)),
      ...resources.map(resource=>resource.region)
    ])].filter(region=>region.length<=64&&/^[a-z]{2,8}(?:-[a-z0-9]+)+-\d+$/.test(region)).sort();
  }

  private async instances(account: AwsAccount, region: string): Promise<AwsDiscoveredInstance[]> {
    let nextToken: string | undefined, pageCount = 0;
    const seenTokens = new Set<string>(), resources: AwsDiscoveredInstance[] = [];
    do {
      if (!isAwsAccountEnabled(account, this.accounts)) throw new DiscoveryFailure('connection_suspended');
      const page = await this.io.instances(account, region, nextToken, this.accounts);
      resources.push(...page.instances);
      nextToken = page.nextToken;
      if (!nextToken) break;
      if (seenTokens.has(nextToken)) throw new DiscoveryFailure('repeated_page_token', 'partial');
      seenTokens.add(nextToken);
      if (++pageCount >= PAGE_LIMIT) throw new DiscoveryFailure('page_limit_exceeded', 'partial');
    } while (nextToken);
    return resources;
  }
}
