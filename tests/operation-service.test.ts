import { expect, it, vi } from 'vitest';
import { OperationService } from '../server/operation-service.js';
import { Store } from '../server/store.js';
import type { Resource } from '../server/types.js';

const resource: Resource = { id: 'aws:test:i-race', name: 'Race EC2', kind: 'ec2', state: 'running', location: 'us-east-1', account: 'test', detail: 't3.small', actions: ['stop'], observedAt: '2026-10-23T08:00:00.000Z' };

it('no deja una operación accepted si el plan vence antes de consumirse atómicamente', async () => {
  const store = new Store(':memory:');
  const base = Date.now();
  const created = store.createOperationPlan('agent', 'race-plan', resource, 'stop', 'policy-v1', base, 5000);
  let executions = 0;
  const operationService = new OperationService(
    store,
    async () => [resource],
    (id, resources) => ({ resource: resources.find(item => item.id === id), canonicalId: id }),
    async () => { executions++; return { message: 'Should not execute.' }; },
    () => false,
    () => true,
    () => 'policy-v1',
    () => base + 4999
  );
  vi.spyOn(store, 'consumeOperationPlan').mockReturnValue('expired');

  const result = await operationService.executePlan('agent', created.plan.id);
  expect(result).toEqual({ status: 'expired' });
  expect(store.list()).toEqual([]);
  expect(store.busy(resource.id)).toBe(false);
  expect(executions).toBe(0);
  store.close();
});
