import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createServiceWorker(cacheName: string, files: string[]): string {
  return `/* Generated. Public shell only: never caches API, session or operations. */
const CACHE=${JSON.stringify(cacheName)};
const FILES=${JSON.stringify(files)};
const isApiPath=pathname=>pathname==='/api'||pathname.startsWith('/api/');
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name.startsWith('infra-shell-')&&name!==CACHE).map(name=>caches.delete(name)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data==='ACTIVATE_UPDATE')self.skipWaiting()});
self.addEventListener('push',event=>{
 let input={};
 try{input=event.data?event.data.json():{}}catch{input={body:event.data?event.data.text():''}}
 const expiresAt=typeof input.expiresAt==='string'?Date.parse(input.expiresAt):NaN;
 if(Number.isFinite(expiresAt)&&expiresAt<=Date.now())return;
 const clean=(value,max)=>typeof value==='string'?value.replace(/[\\u0000-\\u001f\\u007f]/g,' ').replace(/\\s+/g,' ').trim().slice(0,max):'';
 let target;
 try{target=new URL(typeof input.url==='string'?input.url:'/',''+self.location.origin)}catch{target=new URL('/',self.location.origin)}
 if(target.origin!==self.location.origin||isApiPath(target.pathname))target=new URL('/',self.location.origin);
 const title=clean(input.title,64)||'Infra Control';
 const body=clean(input.body,180)||'Hay una actualización de tu infraestructura.';
 event.waitUntil(self.registration.showNotification(title,{body,icon:'/icon-192.png',badge:'/icon-192.png',tag:clean(input.tag,64)||'infra-update',renotify:false,data:{url:target.pathname+target.search+target.hash}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const raw=event.notification.data&&typeof event.notification.data.url==='string'?event.notification.data.url:'/';
 let target;
 try{target=new URL(raw,self.location.origin)}catch{target=new URL('/',self.location.origin)}
 if(target.origin!==self.location.origin||isApiPath(target.pathname))target=new URL('/',self.location.origin);
 event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{
  for(const client of windows){
   if(new URL(client.url).origin!==self.location.origin)continue;
   if('navigate' in client)await client.navigate(target.href);
   return client.focus();
  }
  return self.clients.openWindow(target.href);
 }));
});
self.addEventListener('fetch',event=>{
 const request=event.request;const url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||isApiPath(url.pathname)||url.pathname==='/health')return;
 if(request.mode==='navigate'){event.respondWith(fetch(request).catch(()=>caches.open(CACHE).then(cache=>cache.match('/index.html'))));return;}
 if(FILES.includes(url.pathname))event.respondWith(caches.open(CACHE).then(cache=>cache.match(url.pathname)).then(cached=>cached||fetch(request)));
});
`;
}

function build(): void {
  const files = [
    '/index.html',
    '/manifest.webmanifest',
    '/icon-192.png',
    '/icon-512.png',
    '/apple-touch-icon.png',
    ...readdirSync('dist/assets').map(file => `/assets/${file}`)
  ];
  const hash = createHash('sha256');
  for (const file of files) hash.update(readFileSync(`dist${file}`));
  const version = `infra-shell-${hash.digest('hex').slice(0, 16)}`;
  writeFileSync('dist/sw.js', createServiceWorker(version, files));
  console.log(`Service Worker: ${files.length} archivos públicos; API excluida.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) build();
