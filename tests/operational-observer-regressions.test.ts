import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
import type { Config, Resource } from '../server/types.js';

describe('observación operativa sin depender de historia completa', () => {
  it('no pierde incidentes entre páginas cuando se reconoce uno aún no mostrado', () => {
    const store = new Store(':memory:');
    try {
      const resources: Resource[] = ['one', 'two', 'three'].map(name => ({ id: `computer:${name}`, name, kind: 'computer', state: 'stopped', account: 'fixture', location: 'fixture', detail: 'fixture', actions: [], observedAt: new Date().toISOString() }));
      for (const resource of resources) store.operational.setExpectation(resource.id, 'always-on', 0);
      store.operational.observeResources(resources);
      const first = store.operational.incidentPage({ view: 'current', limit: 2 }, 'fixture', () => true);
      const unshown = store.operational.incidentPage({ view: 'current', limit: 20 }, 'fixture', () => true).incidents.find(incident => !first.incidents.some(row => row.id === incident.id))!;
      store.operational.acknowledge(unshown.id, unshown.version);
      const second = store.operational.incidentPage({ view: 'current', limit: 2, cursor: first.nextCursor! }, 'fixture', () => true);
      expect(second.incidents.map(incident => incident.id)).toContain(unshown.id);
    } finally { store.close(); }
  });
  it('abre y recupera fallos explícitos de una instantánea aunque no quede el evento original', () => {
    const store = new Store(':memory:');
    try {
      const at = new Date().toISOString();
      const host: Resource = { id: 'computer:fixture', name: 'Fixture', kind: 'computer', state: 'running', account: 'fixture', location: 'fixture', detail: 'fixture', actions: [], observedAt: at,
        serviceSignals: { hermes: { state: 'unhealthy', source: 'hermes-systemd-reporter', observedAt: at, freshUntil: new Date(Date.now() + 60000).toISOString(), reasonCode: 'unit_failed' } } };
      store.operational.observeResources([host]);
      expect(store.operational.summary(() => true, () => true).attentionGroups).toBe(1);
      host.serviceSignals!.hermes!.state = 'healthy';
      store.operational.observeResources([host]);
      expect(store.operational.summary(() => true, () => true).attentionGroups).toBe(0);
    } finally { store.close(); }
  });
  it('no exige scopes históricos de conexiones que ya no están configuradas ni inventa recuperación', async () => {
    const origin = 'https://control.example.test';
    const config: Config = { origin, passwordHash: 'unused', agentTokens: [], aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' } };
    const app = createApp(config, ':memory:', { inventory: async () => [], localInventory: async () => [], perform: async () => ({ message: 'fixture' }) });
    try {
      const store: Store = app.locals.store;
      const connection = app.locals.catalog.registerConnection({ provider: 'coolify', providerAccountId: 'https://retired.example.test', name: 'Retired', credentialRef: 'fixture' });
      app.locals.catalog.reconcileScope(connection.id, 'coolify:inventory', [], { complete: false, observedAt: new Date().toISOString(), errorCode: 'fixture_unavailable', state: 'failed' });
      expect(store.operational.summary(() => true, () => true).coverageProblems).toBe(1);
      store.addSession(tokenHash('observer-fixture-session'));
      const response = await request(app).get('/api/attention/summary').set('Cookie', '__Host-infra=observer-fixture-session');
      expect(response.status).toBe(200);
      expect(response.body.counts.coverageProblems).toBe(0);
      expect(response.body.coverage.scopes).toBe(0);
      const history = store.operational.incidentPage({ view: 'history', limit: 20 }, 'fixture', () => true);
      expect(history.incidents).toContainEqual(expect.objectContaining({ status: 'information', evidence: expect.objectContaining({ reasonCode: 'scope_no_longer_configured' }) }));
      expect(history.incidents.some(incident => incident.status === 'resolved')).toBe(false);
    } finally { app.locals.close(); }
  });
});
