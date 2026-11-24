import { z } from 'zod';
import { posix } from 'node:path';

export const isPrivateSnapshotDirectory = (value: string): boolean => value.startsWith('/') && value !== '/' && value.length <= 1024 && !/[\u0000-\u0020\u007f-\u009f\\]/.test(value) && posix.normalize(value) === value && value.split('/').every(part => part !== '.' && part !== '..');
export const hostConfigurationSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  displayName: z.string().min(1).max(120).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value)),
  enabled: z.boolean().default(true),
  snapshotDirectory: z.string().refine(isPrivateSnapshotDirectory),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  monitoring: z.object({ enabled: z.boolean() }).strict().optional()
}).strict();
export const hostConfigurationsSchema = z.array(hostConfigurationSchema).max(16).superRefine((items, context) => {
  for (const field of ['key', 'snapshotDirectory', 'expectedFingerprint'] as const) {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item[field])) context.addIssue({ code: 'custom', path: [index, field], message: 'duplicate host configuration' });
      seen.add(item[field]);
    });
  }
});
