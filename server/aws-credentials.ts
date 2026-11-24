import { STSClient, AssumeRoleCommand, type AssumeRoleCommandOutput } from '@aws-sdk/client-sts';
import type { AwsAccount } from './types.js';

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date };
export type AwsCredentialProvider = () => Promise<AwsCredentials>;
export type AwsCredentialIO = {
  sts(credentials: AwsCredentials): {
    send(command: AssumeRoleCommand, options?: { abortSignal?: AbortSignal }): Promise<Partial<AssumeRoleCommandOutput>>;
    destroy?(): void;
  };
  now(): number;
};
const RENEW_BEFORE_MS = 300_000;
const rolePattern = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
function invalid(): never { throw new Error('Invalid AWS configuration'); }
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

export function validateAwsAccounts(accounts: readonly AwsAccount[]): void {
  const names = new Set<string>(), identities = new Map<string, AwsAccount>();
  for (const account of accounts) {
    if (!text(account.name, 120) || account.name.includes(':') || !/^\d{12}$/.test(account.accountId)) invalid();
    const name = account.name.normalize('NFKC').toLowerCase();
    if (names.has(name)) invalid();
    names.add(name);
    if (account.displayName !== undefined && !text(account.displayName, 120)) invalid();
    if (account.enabled !== undefined && typeof account.enabled !== 'boolean') invalid();
    if (account.disabledReason !== undefined && (account.disabledReason !== 'account_suspended' || account.enabled !== false)) invalid();
    const role = account.roleArn !== undefined || account.sourceAccount !== undefined;
    if (role) {
      if (!text(account.roleArn, 2048) || rolePattern.exec(account.roleArn)?.[1] !== account.accountId || !text(account.sourceAccount, 120)) invalid();
      if (account.accessKeyId !== undefined || account.secretAccessKey !== undefined || account.sessionToken !== undefined) invalid();
    } else {
      if (!text(account.accessKeyId, 4096) || !text(account.secretAccessKey, 4096)) invalid();
      if (account.sessionToken !== undefined && !text(account.sessionToken, 16384)) invalid();
    }
    const previous = identities.get(account.accountId);
    if (previous && ((previous.enabled !== false) !== (account.enabled !== false)
      || previous.roleArn !== account.roleArn || previous.sourceAccount !== account.sourceAccount
      || previous.accessKeyId !== account.accessKeyId || previous.secretAccessKey !== account.secretAccessKey
      || previous.sessionToken !== account.sessionToken)) invalid();
    identities.set(account.accountId, account);
    const instances = new Set<string>();
    for (const instance of account.instances ?? []) {
      const key = `${instance.region}:${instance.id}`;
      if (instances.has(key)) invalid();
      instances.add(key);
    }
  }
  const byName = new Map(accounts.map(account => [account.name, account]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (account: AwsAccount): void => {
    if (visiting.has(account.name)) invalid();
    if (visited.has(account.name)) return;
    visiting.add(account.name);
    if (account.roleArn !== undefined) {
      const source = byName.get(account.sourceAccount!);
      if (!source || source.enabled === false) invalid();
      visit(source);
    }
    visiting.delete(account.name);
    visited.add(account.name);
  };
  for (const account of accounts) visit(account);
}

/** Pure gate, also used before injected IO; unknown or disabled sources fail closed. */
export function isAwsAccountEnabled(account: AwsAccount, accounts: readonly AwsAccount[]): boolean {
  const seen = new Set<string>();
  let current: AwsAccount | undefined = account;
  while (current) {
    if (current.enabled === false || seen.has(current.name) || accounts.some(item => item.accountId === current!.accountId && item.enabled === false)) return false;
    seen.add(current.name);
    if (current.roleArn === undefined) return true;
    const sources = accounts.filter(item => item.name === current!.sourceAccount);
    if (sources.length !== 1) return false;
    current = sources[0];
  }
  return false;
}

const defaultIO: AwsCredentialIO = {
  sts: credentials => new STSClient({ region: 'us-east-1', credentials, maxAttempts: 1, requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 } }),
  now: () => Date.now()
};
function unavailable(): Error {
  const error = new Error('AWS credentials unavailable');
  error.name = 'AwsCredentialsUnavailableError';
  return error;
}

export function createAwsCredentialFactory(io: AwsCredentialIO = defaultIO) {
  const providers = new WeakMap<AwsAccount, WeakMap<readonly AwsAccount[], AwsCredentialProvider>>();
  const singleAccountLists = new WeakMap<AwsAccount, readonly AwsAccount[]>();
  function credentials(account: AwsAccount, configured?: readonly AwsAccount[]): AwsCredentialProvider {
    let accounts = configured ?? singleAccountLists.get(account);
    if (!accounts) { accounts = [account]; singleAccountLists.set(account, accounts); }
    const scope = accounts;
    let contexts = providers.get(account);
    if (!contexts) { contexts = new WeakMap(); providers.set(account, contexts); }
    const existing = contexts.get(scope);
    if (existing) return existing;
    let cached: AwsCredentials | undefined, pending: Promise<AwsCredentials> | undefined;
    const provider: AwsCredentialProvider = async () => {
      try {
        validateAwsAccounts(scope);
        if (!scope.includes(account) || !isAwsAccountEnabled(account, scope)) throw unavailable();
        if (account.roleArn === undefined) return {
          accessKeyId: account.accessKeyId!, secretAccessKey: account.secretAccessKey!,
          ...(account.sessionToken !== undefined ? { sessionToken: account.sessionToken } : {})
        };
        if (cached?.expiration && cached.expiration.getTime() - io.now() > RENEW_BEFORE_MS) return cached;
        if (!pending) pending = (async () => {
          const source = scope.find(item => item.name === account.sourceAccount);
          if (!source) throw unavailable();
          const sourceCredentials = await credentials(source, scope)();
          if (!isAwsAccountEnabled(account, scope)) throw unavailable();
          const client = io.sts(sourceCredentials);
          try {
            const result = await client.send(new AssumeRoleCommand({ RoleArn: account.roleArn, RoleSessionName: 'infra-control-monitor', DurationSeconds: 900 }), { abortSignal: AbortSignal.timeout(15000) });
            const value = result.Credentials;
            const expires = value?.Expiration?.getTime();
            if (!text(value?.AccessKeyId, 4096) || !text(value?.SecretAccessKey, 4096) || !text(value?.SessionToken, 16384)
              || expires === undefined || !Number.isFinite(expires) || expires <= io.now() || !isAwsAccountEnabled(account, scope)) throw unavailable();
            cached = { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey, sessionToken: value.SessionToken, expiration: new Date(expires) };
            return cached;
          } finally { client.destroy?.(); }
        })().finally(() => { pending = undefined; });
        return await pending;
      } catch { throw unavailable(); }
    };
    contexts.set(scope, provider);
    return provider;
  }
  return credentials;
}

/** Shared by discovery, inventory, operations, CE and Budgets. Construction is lazy. */
export const awsCredentials = createAwsCredentialFactory();
