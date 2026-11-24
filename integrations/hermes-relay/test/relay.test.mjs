import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('real connector: HTTP, streaming, cookies, media, WebSockets, disconnect and isolation', {timeout:90000}, async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules:true, scriptPath:fileURLToPath(new URL('../src/worker.js',import.meta.url)),
    compatibilityDate:'2026-07-30', port:0,
    durableObjects:{RELAY:{className:'Relay',useSQLite:true}},
    bindings:{CLIENT_KEY:'c'.repeat(48),CONNECTOR_KEY:'b'.repeat(48)}
  }));
  try {
    const origin=(await mf.ready).origin;
    const child=spawn('.venv/bin/python',['test/integration.py',origin],{stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
    const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
    assert.equal(code,0,`${out}\n${err}`);
    assert.match(out,/ALL CHECKS PASSED/);
    console.log(out.trim());
  } finally {await mf.dispose();}
});
