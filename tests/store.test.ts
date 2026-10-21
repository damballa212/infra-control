import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../server/store.js';
import type { Resource } from '../server/types.js';
import { DeploymentBlockedError } from '../server/store.js';
it('persiste idempotencia y marca incierta una orden interrumpida sin volver a ejecutarla', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infra-store-')), path = join(dir, 'test.sqlite');
  let store = new Store(path);
  const resource = { id: 'aws:test:instance', name: 'Test' } as Resource;
  const op = store.create('actor', 'same-order', 'payload', resource, 'stop');
  store.addSession('test-hash'); store.putCache('test-cache', { useful: true }, 10000); store.close();
  store = new Store(path);
  expect(store.get(op.id)?.state).toBe('uncertain'); expect(store.existing('actor', 'same-order')?.id).toBe(op.id);
  expect(store.operationHistory(op.id).map(event => event.payload.state)).toEqual(['accepted', 'uncertain']);
  expect(store.session('test-hash')).toBe(true); expect(store.cache('test-cache')?.value).toEqual({ useful: true });
  const next = store.create('actor', 'next-order', 'payload2', resource, 'refresh');
  expect(() => store.create('other-actor', 'parallel', 'payload3', resource, 'stop')).toThrow();
  store.update(next.id, 'succeeded', 'done'); store.close(); rmSync(dir, { recursive: true });
});

it('guarda transiciones de operaciones como historial durable y no duplica estados idénticos', () => {
  const store = new Store(':memory:');
  const resource = { id: 'aws:test:instance', name: 'Test' } as Resource;
  const op = store.create('actor', 'history-key', 'payload', resource, 'stop');
  store.update(op.id, 'running', 'Ejecutando');
  store.update(op.id, 'running', 'Ejecutando');
  store.update(op.id, 'succeeded', 'Confirmado');
  const history = store.operationHistory(op.id);
  expect(history.map(event => event.payload.state)).toEqual(['accepted', 'running', 'succeeded']);
  expect(history.map(event => event.id)).toEqual([...history.map(event => event.id)].sort((a, b) => a - b));
  store.close();
});

it('reproduce eventos desde un cursor monotónico y detecta cursores fuera de ventana', () => {
  const store = new Store(':memory:');
  const first = store.appendEvent('resource', 'router:fiberhome', { state: 'reporting' });
  const second = store.appendEvent('incident', 'home-link', { state: 'open' });
  expect(second).toBeGreaterThan(first);
  expect(store.eventsAfter(first).map(event => event.id)).toEqual([second]);
  expect(store.eventBounds()).toMatchObject({ first, latest: second });
  store.close();
});

it('cierra la carrera entre despliegue y alta de órdenes mediante una compuerta atómica', () => {
  const store = new Store(':memory:');
  const resource = { id: 'router:fiberhome', name: 'Router' } as Resource;
  const now = Date.now();
  store.db.prepare("INSERT INTO settings(key,value) VALUES ('deployment-gate',?)").run(JSON.stringify({ owner: 'deploy-fixture', expiresAt: new Date(now + 60000).toISOString() }));
  expect(store.deploymentBlocked(now)).toBe(true);
  expect(() => store.create('actor', 'during-deploy', 'payload', resource, 'refresh')).toThrow(DeploymentBlockedError);
  expect(store.list()).toHaveLength(0);
  store.db.prepare("UPDATE settings SET value=? WHERE key='deployment-gate'").run(JSON.stringify({ owner: 'expired', expiresAt: new Date(now - 1).toISOString() }));
  expect(store.deploymentBlocked(now)).toBe(false);
  expect(store.create('actor', 'after-deploy', 'payload', resource, 'refresh').state).toBe('accepted');
  store.close();
});

it('guarda una preferencia de arranque offline cancelable y no bloquea WOL', () => {
  const store = new Store(':memory:');
  const applying = store.beginDesktopBootPreference('boot-default-1', 'windows', 0);
  expect(applying).toMatchObject({ desired: 'windows', effective: null, state: 'applying', version: 1 });
  const pending = store.finishDesktopBootPreference('boot-default-1', 'pending', 'La PC aplicará el cambio al reconectarse.');
  expect(pending).toMatchObject({ desired: 'windows', effective: null, state: 'pending', version: 1 });

  const resource = { id: 'computer:desktop', name: 'PC de casa' } as Resource;
  expect(store.create('actor', 'wake-1', 'wake', resource, 'start').state).toBe('accepted');
  expect(() => store.beginDesktopBootPreference('boot-default-2', 'cachyos', 0)).toThrow('version');
  expect(store.cancelPendingDesktopBootPreference(1)).toMatchObject({ desired: null, effective: null, state: 'unknown', version: 2 });
  store.close();
});

it('una lectura nueva de UEFI resuelve una intención y detecta cambios externos sin corregirlos', () => {
  const store = new Store(':memory:');
  store.beginDesktopBootPreference('boot-default-1', 'windows', 0);
  store.finishDesktopBootPreference('boot-default-1', 'pending', 'pending');
  const matched = store.observeDesktopBootDefault('windows', new Date().toISOString());
  expect(matched).toMatchObject({ desired: 'windows', effective: 'windows', state: 'applied', version: 1 });
  const drift = store.observeDesktopBootDefault('cachyos', new Date().toISOString());
  expect(drift).toMatchObject({ desired: 'windows', effective: 'cachyos', state: 'drift', version: 1 });
  store.close();
});
