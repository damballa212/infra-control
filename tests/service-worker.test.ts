import { expect, it } from 'vitest';
import { createServiceWorker } from '../design/handoff/checks/build-service-worker.js';

it('recibe push con cabecera, icono, resumen y destino local sin almacenar datos privados en caché', () => {
  const source = createServiceWorker('infra-shell-test', ['/index.html', '/assets/app-test.js']);
  expect(source).toContain("self.addEventListener('push'");
  expect(source).toContain('self.registration.showNotification');
  expect(source).toContain("icon:'/icon-192.png'");
  expect(source).toContain("badge:'/icon-192.png'");
  expect(source).toContain("expiresAt<=Date.now()");
  expect(source).toContain("self.addEventListener('notificationclick'");
  expect(source).toContain('isApiPath(url.pathname)');
  expect(source).toContain("request.method!=='GET'||url.origin!==self.location.origin||isApiPath(url.pathname)");
});

it('bloquea URLs de notificación fuera del origen del panel', () => {
  const source = createServiceWorker('infra-shell-test', ['/index.html']);
  expect(source).toContain('target.origin!==self.location.origin');
  expect(source).toContain('isApiPath(target.pathname)');
  expect(source).toContain("pathname==='/api'");
  expect(source).toContain("try{target=new URL(raw,self.location.origin)}catch{target=new URL('/',self.location.origin)}");
});
