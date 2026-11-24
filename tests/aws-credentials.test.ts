import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EC2Client } from '@aws-sdk/client-ec2';
import { AssumeRoleCommand, type AssumeRoleCommandOutput } from '@aws-sdk/client-sts';
import { createAwsCredentialFactory, validateAwsAccounts, type AwsCredentials } from '../server/aws-credentials.js';
import type { AwsAccount } from '../server/types.js';

const source = (): Extract<AwsAccount, { accessKeyId: string }> => ({ name: 'prod', accountId: '100000000002', accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' });
const target = (): Extract<AwsAccount, { roleArn: string }> => ({ name: 'shop-dev', displayName: 'shop · Producción', accountId: '100000000001', roleArn: 'arn:aws:iam::100000000001:role/infra-control-production-monitor', sourceAccount: 'prod', instances: [] });
function fixture() {
  const accounts = [source(), target()];
  const send = vi.fn(async (_command: AssumeRoleCommand): Promise<Partial<AssumeRoleCommandOutput>> => ({ Credentials: {
    AccessKeyId: 'temporary-fixture-key', SecretAccessKey: 'temporary-fixture-secret', SessionToken: 'temporary-fixture-session', Expiration: new Date(Date.now() + 900000)
  } }));
  const destroy = vi.fn();
  const sts = vi.fn((_credentials: AwsCredentials) => ({ send, destroy }));
  return { accounts, send, sts, destroy, factory: createAwsCredentialFactory({ sts, now: () => Date.now() }) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('credenciales AWS compartidas y perezosas', () => {
  it('no consulta al validar, obtener el provider ni crear un SDK client', () => {
    const f = fixture();
    validateAwsAccounts(f.accounts);
    const provider = f.factory(f.accounts[1], f.accounts);
    const client = new EC2Client({ region: 'us-east-1', credentials: provider });
    try {
      expect(f.factory(f.accounts[1], f.accounts)).toBe(provider);
      expect(f.sts).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    } finally { client.destroy(); }
  });

  it('resuelve la fuente por name y comparte AssumeRole concurrente con renovación anticipada', async () => {
    const f = fixture(), provider = f.factory(f.accounts[1], f.accounts);
    const values = await Promise.all(Array.from({ length: 12 }, () => provider()));
    expect(f.sts).toHaveBeenCalledTimes(1);
    expect(f.sts.mock.calls[0][0]).toEqual({ accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' });
    expect(f.send.mock.calls[0][0].input).toEqual({ RoleArn: target().roleArn, RoleSessionName: 'infra-control-monitor', DurationSeconds: 900 });
    expect(values.every(value => value === values[0])).toBe(true);
    expect(Object.keys(values[0]).sort()).toEqual(['accessKeyId', 'expiration', 'secretAccessKey', 'sessionToken']);
    vi.setSystemTime(new Date('2026-11-14T12:09:59Z'));
    await provider();
    expect(f.send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-14T12:10:01Z'));
    await Promise.all([provider(), provider(), provider()]);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.destroy).toHaveBeenCalledTimes(2);
  });

  it('no exporta metadata ni llama STS para credenciales estáticas', async () => {
    const f = fixture();
    expect(await f.factory(f.accounts[0], f.accounts)()).toEqual({ accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' });
    expect(f.sts).not.toHaveBeenCalled();
  });

  it('aísla la caché entre objetos y contextos de configuración', async () => {
    const f = fixture();
    await f.factory(f.accounts[1], f.accounts)();
    const other = [source(), target()];
    await f.factory(other[1], other)();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('rechaza fuentes desconocidas, suspendidas, ciclos y roles de otra cuenta sin STS', async () => {
    const f = fixture();
    const cases: AwsAccount[][] = [
      [source(), { ...target(), sourceAccount: 'missing' }],
      [{ ...source(), enabled: false, disabledReason: 'account_suspended' }, target()],
      [{ ...target(), roleArn: 'arn:aws:iam::999999999999:role/wrong' }, source()],
      [
        { name: 'one', accountId: '111111111111', roleArn: 'arn:aws:iam::111111111111:role/one', sourceAccount: 'two' },
        { name: 'two', accountId: '222222222222', roleArn: 'arn:aws:iam::222222222222:role/two', sourceAccount: 'one' }
      ]
    ];
    for (const accounts of cases) {
      expect(() => validateAwsAccounts(accounts)).toThrow('Invalid AWS configuration');
      await expect(f.factory(accounts[0], accounts)()).rejects.toThrow('AWS credentials unavailable');
    }
    expect(f.sts).not.toHaveBeenCalled();
  });

  it('no reutiliza credenciales cacheadas después de suspender la fuente', async () => {
    const f = fixture(), provider = f.factory(f.accounts[1], f.accounts);
    await provider();
    f.accounts[0].enabled = false;
    f.accounts[0].disabledReason = 'account_suspended';
    await expect(provider()).rejects.toThrow('AWS credentials unavailable');
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('redacta errores, limpia singleflight fallido y permite un intento posterior', async () => {
    const f = fixture(), provider = f.factory(f.accounts[1], f.accounts);
    f.send.mockRejectedValueOnce(new Error('fixture-secret raw provider response'));
    const failed = await Promise.allSettled([provider(), provider()]);
    for (const result of failed) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason.message).toBe('AWS credentials unavailable');
        expect(result.reason.name).toBe('AwsCredentialsUnavailableError');
        expect(result.reason.cause).toBeUndefined();
      }
    }
    expect(f.send).toHaveBeenCalledTimes(1);
    await expect(provider()).resolves.toMatchObject({ accessKeyId: 'temporary-fixture-key' });
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it.each(['expired', 'missing-token'] as const)('rechaza respuestas STS %s', async kind => {
    const f = fixture();
    f.send.mockResolvedValueOnce({ Credentials: { AccessKeyId: 'fixture', SecretAccessKey: 'fixture', SessionToken: kind === 'missing-token' ? undefined : 'fixture', Expiration: new Date(kind === 'expired' ? Date.now() - 1 : Date.now() + 900000) } });
    await expect(f.factory(f.accounts[1], f.accounts)()).rejects.toThrow('AWS credentials unavailable');
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });
});
