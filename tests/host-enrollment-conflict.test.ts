import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { CatalogRepository } from '../server/catalog.js';
import type { HostObservationCoordinator } from '../server/host-observation.js';
import { Store } from '../server/store.js';
import type { Adapter, Config } from '../server/types.js';
import { HOST_PIN, ROOT_DIRECTORY, nativeSample, trustedFixture } from './fixtures/native-host.js';

it('starts with a conflicting persisted enrollment and registers a valid separate provider', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'infra-host-conflict-'));
  const db = join(directory, 'infra.sqlite');
  let app: ReturnType<typeof createApp> | undefined;
  try {
    const seed = new Store(db);
    let hostConnection: string;
    try {
      const binding = seed.hostObservations.bind('fixture-host', HOST_PIN);
      hostConnection = new CatalogRepository(seed).registerConnection({ provider: 'host', providerAccountId: binding.accountId, name: binding.accountId, credentialRef: 'fixture' }).id;
    } finally { seed.close(); }
    const source = trustedFixture(nativeSample(Date.now()));
    const config: Config = { origin: 'https://control.example.test', passwordHash: 'fixture', aws: [],
      coolify: { url: 'https://coolify.example.test', token: '', resources: [] }, acs: { url: '', deviceId: '' }, agentTokens: [],
      hosts: [{ key: 'fixture-host', displayName: 'Fixture', enabled: true, snapshotDirectory: ROOT_DIRECTORY, expectedFingerprint: 'e'.repeat(64) }] };
    const perform = vi.fn(async () => ({ message: 'unused' }));
    const adapter: Adapter = { inventory: async () => [], perform };
    app = createApp(config, db, adapter, undefined, undefined, undefined, { files: source.io });
    const observation = app.locals.hostObservation as HostObservationCoordinator;
    await observation.poll();
    expect(observation.enrollmentConflictCount).toBe(1);
    expect(observation.snapshot()).toEqual([]);
    expect(source.reads()).toBe(0);
    const catalog = app.locals.catalog as CatalogRepository;
    expect(catalog.connections()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: hostConnection, state: 'suspended' }),
      expect.objectContaining({ provider: 'coolify', state: 'active' })
    ]));
    expect(perform).not.toHaveBeenCalled();
  } finally {
    app?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
