import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { mountFrontend } from '../server/frontend.js';
describe('UI del handoff en el mismo origen sin alterar API', () => {
 it('sirve rutas SPA y SW revalidable sin disfrazar errores API o assets faltantes como HTML', async () => {
  const root = mkdtempSync(join(tmpdir(),'infra-web-'));
  mkdirSync(join(root,'assets')); writeFileSync(join(root,'index.html'),'<html>HANDOFF</html>'); writeFileSync(join(root,'sw.js'),'// public worker'); writeFileSync(join(root,'assets','app-12345678.js'),'// js');
  const app=express(); app.get('/health',(_q,r)=>{r.json({status:'ok'});}); app.use('/api',(_q,r)=>{r.status(404).json({error:'API'});}); mountFrontend(app,root); app.use((_q,r)=>{r.status(404).end();});
  try {
   expect((await request(app).get('/control').set('Accept','text/html')).text).toContain('HANDOFF');
   expect((await request(app).get('/control')).headers['cache-control']).toBe('no-store');
   expect((await request(app).get('/sw.js')).headers['cache-control']).toBe('no-cache');
   expect((await request(app).get('/assets/app-12345678.js')).headers['cache-control']).toContain('immutable');
   expect((await request(app).get('/api/missing')).body).toEqual({error:'API'});
   expect((await request(app).get('/health')).body).toEqual({status:'ok'});
   expect((await request(app).get('/assets/missing.js').set('Accept','text/html')).status).toBe(404);
   expect((await request(app).get('/.env').set('Accept','text/html')).status).toBe(404);
   expect((await request(app).post('/control')).status).toBe(404);
  } finally {rmSync(root,{recursive:true,force:true});}
 });
});
