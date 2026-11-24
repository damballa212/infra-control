import { describe, expect, it } from 'vitest';
import { parseConfig } from '../server/config.js';

const base = { origin: 'https://control.example.test', passwordHash: 'fixture', agentTokens: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' }, preservedRoot: { enabled: true } };
const source = { name: 'prod', accountId: '100000000002', accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret', preservedAWS: 'kept' };
const role = { name: 'shop-dev', displayName: 'shop · Producción', accountId: '100000000001', roleArn: 'arn:aws:iam::100000000001:role/infra-control-production-monitor', sourceAccount: 'prod', instances: [] };

describe('configuración AWS de stage A', () => {
  it('acepta estáticas y roles, aplica defaults y conserva campos passthrough', () => {
    const parsed = parseConfig({ ...base, aws: [source, role, { name: 'lab', accountId: '999999999999', accessKeyId: 'fixture-g', secretAccessKey: 'fixture-g', enabled: false }] });
    expect(parsed.aws[0]).toEqual({ ...source, enabled: true, displayName: source.name });
    expect(parsed.aws[1]).toEqual({ ...role, enabled: true });
    expect(parsed.aws[2]).toMatchObject({ enabled: false, disabledReason: 'account_suspended', displayName: 'lab' });
    expect((parsed as unknown as Record<string, unknown>).preservedRoot).toEqual(base.preservedRoot);
    expect(parsed.aws[1].name).toBe('shop-dev');
    expect(parsed.aws[1].accessKeyId).toBeUndefined();
    expect(source).not.toHaveProperty('enabled');
  });

  it('conserva perfiles alias coherentes de la misma identidad física', () => {
    expect(parseConfig({ ...base, aws: [source, { ...source, name: 'source-alias' }] }).aws).toHaveLength(2);
  });

  it('rechaza credenciales incompletas, mezcladas, roles ajenos y referencias ambiguas', () => {
    const invalid = [
      [{ ...source, secretAccessKey: undefined }],
      [{ ...source, accessKeyId: '' }],
      [source, { ...role, accessKeyId: 'copied', secretAccessKey: 'copied' }],
      [source, { ...role, roleArn: 'arn:aws:iam::111111111111:role/wrong' }],
      [source, { ...role, sourceAccount: source.accountId }],
      [source, { ...role, sourceAccount: 'missing' }],
      [{ ...source, enabled: false }, role],
      [source, { ...source, name: 'prod' }],
      [source, { ...source, name: 'alias', secretAccessKey: 'different' }],
      [source, { ...source, name: 'alias', enabled: false }],
      [{ ...source, disabledReason: 'account_suspended' }],
      [{ ...source, displayName: 'bad\nlabel' }],
      [{ ...source, enabled: 'false' }],
      [{ ...source, accountId: 'short' }]
    ];
    for (const aws of invalid) expect(() => parseConfig({ ...base, aws })).toThrow('Invalid server configuration');
  });

  it('rechaza ciclos sin hacer descubrimiento ni resolver credenciales', () => {
    const aws = [
      { name: 'one', accountId: '111111111111', roleArn: 'arn:aws:iam::111111111111:role/one', sourceAccount: 'two' },
      { name: 'two', accountId: '222222222222', roleArn: 'arn:aws:iam::222222222222:role/two', sourceAccount: 'one' }
    ];
    expect(() => parseConfig({ ...base, aws })).toThrow('Invalid server configuration');
  });
});
