import { expect, it } from 'vitest';
import { SharedCache } from '../server/cache.js';
it('comparte llamadas concurrentes, respeta TTL y enfría errores', async () => {
  let now = 0, calls = 0;
  const cache = new SharedCache(() => now);
  const load = async () => { calls++; return calls; };
  expect(await Promise.all(Array.from({ length: 20 }, () => cache.get('same', 60000, load)))).toEqual(Array(20).fill(1));
  now = 59999; expect(await cache.get('same', 60000, load)).toBe(1);
  now = 60001; expect(await cache.get('same', 60000, load)).toBe(2);
  const failure = async () => { calls++; throw new Error('429'); };
  await expect(cache.get('error', 60000, failure)).rejects.toThrow('429');
  await expect(cache.get('error', 60000, failure)).rejects.toThrow('429'); expect(calls).toBe(3);
});
