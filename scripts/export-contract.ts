import { writeFileSync, mkdirSync } from 'node:fs';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { tokenHash } from '../server/auth.js';
const token = 'contract-export-fixture-not-a-live-token';
const app = createApp({ origin: 'https://panel.example.com', passwordHash: 'not-used', agentTokens: [{ name: 'export-only', hash: tokenHash(token), scopes: ['read'] }], aws: [], coolify: { url: '', token: '', resources: [] }, acs: { url: '', deviceId: '' } }, ':memory:', { inventory: async () => [], perform: async () => { throw new Error('Contract exporter never runs operations'); } });
try {
  const response = await request(app).get('/api/openapi.json').set('Authorization', `Bearer ${token}`);
  if (response.status !== 200) throw new Error('Contract export failed');
  mkdirSync('contracts', { recursive: true });
  writeFileSync('contracts/openapi.json', JSON.stringify(response.body, null, 2) + '\n');
  console.log('Public API contract exported. No production credentials used.');
} finally { app.locals.close(); }
