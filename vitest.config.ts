import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], coverage: { provider: 'v8', include: ['server/**/*.ts'], exclude: ['server/index.ts'], thresholds: { statements: 80, lines: 80, functions: 80, branches: 75 } } } });
