import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
const run=vi.hoisted(()=>{const fn=vi.fn();Object.defineProperty(fn,Symbol.for('nodejs.util.promisify.custom'),{value:fn,configurable:true});return fn;});
const connect=vi.hoisted(()=>vi.fn());
vi.mock('node:child_process',()=>({execFile:run}));
vi.mock('node:net',()=>({createConnection:connect}));
import { pcBanner, pcCommand, pcStatus } from '../server/pc-control.js';
describe('SSH autenticado y comandos fijos PC',()=>{
 function output(value:unknown){run.mockReset();run.mockResolvedValue({stdout:JSON.stringify(value),stderr:''});}
 it('fija destino loopback, pinning, usuario y comando sin shell',async()=>{
  output({os:'windows',mac:'02:00:00:00:00:01',bootId:'windows-boot-id'});
  expect(await pcCommand('windows','status')).toMatchObject({os:'windows'});
  const [file,args,opts]=run.mock.calls[0]!;
  expect(file).toBe('/usr/bin/ssh');expect(args).toContain('StrictHostKeyChecking=yes');expect(args).toContain('HostKeyAlias=infra-pc-windows');expect(args).toContain('ConnectTimeout=5');expect(args.slice(-2)).toEqual(['winuser@127.0.0.1','status']);expect(opts).toMatchObject({timeout:12000,maxBuffer:2048});expect(opts.shell).toBeUndefined();
 });
 it('rechaza MAC o sistema incorrectos incluso si responde JSON',async()=>{
  output({os:'windows',mac:'00:00:00:00:00:00',bootId:'windows-boot-id'});
  await expect(pcCommand('windows','status')).rejects.toThrow('identity');
  output({os:'cachyos',mac:'02:00:00:00:00:01',bootId:'linux-boot-id'});
  await expect(pcCommand('windows','status')).rejects.toThrow('identity');
 });
 it('no declara recepción de una escritura sin ACK explícito',async()=>{
  output({accepted:false});await expect(pcCommand('cachyos','off')).rejects.toThrow('unacknowledged');
 });
 it('acepta solo defaults conocidos en el estado autenticado del equipo',async()=>{
  output({os:'cachyos',mac:'02:00:00:00:00:01',bootId:'linux-boot-id',defaultSystem:'windows'});
  expect(await pcCommand('cachyos','status')).toMatchObject({defaultSystem:'windows'});
  output({os:'cachyos',mac:'02:00:00:00:00:01',bootId:'linux-boot-id',defaultSystem:'installer'});
  await expect(pcCommand('cachyos','status')).rejects.toThrow('default');
 });
});

class FakeSocket extends EventEmitter {
 timeoutHandler?: () => void;
 readonly destroy=vi.fn();
 setTimeout(_ms:number,handler:()=>void){this.timeoutHandler=handler;return this;}
}

describe('observación rápida de presencia de la PC por el túnel SSH',()=>{
 function socket(){const value=new FakeSocket();connect.mockReturnValue(value as unknown as Socket);return value;}
 it('reconoce el banner Windows una vez recibe una línea completa',async()=>{
  const client=socket(),pending=pcBanner();
  client.emit('data',Buffer.from('SSH-2.0-OpenSSH_for_Windows_9.5\r\n'));
  await expect(pending).resolves.toContain('OpenSSH_for_Windows');
  expect(client.destroy).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledWith({host:'127.0.0.1',port:17723});
 });
 it('devuelve null si el banner no es SSH, excede el límite o vence el sondeo',async()=>{
  const invalid=socket(),invalidPending=pcBanner();invalid.emit('data',Buffer.from('not-ssh\n'));
  await expect(invalidPending).resolves.toBeNull();
  const huge=socket(),hugePending=pcBanner();huge.emit('data',Buffer.from('x'.repeat(513)));
  await expect(hugePending).resolves.toBeNull();
  const slow=socket(),slowPending=pcBanner();slow.timeoutHandler?.();
  await expect(slowPending).resolves.toBeNull();
  expect(invalid.destroy).toHaveBeenCalledOnce();expect(huge.destroy).toHaveBeenCalledOnce();expect(slow.destroy).toHaveBeenCalledOnce();
 });
 it('distingue PC apagada, sistema activo y SSH arriba sin identidad verificable',async()=>{
  const offline=socket(),offlinePending=pcStatus();offline.emit('error',new Error('refused'));
  await expect(offlinePending).resolves.toEqual({online:false,controlled:false});

  run.mockReset();run.mockResolvedValue({stdout:JSON.stringify({os:'windows',mac:'02:00:00:00:00:01',bootId:'windows-boot-id',defaultSystem:'cachyos'}),stderr:''});
  const windows=socket(),windowsPending=pcStatus();windows.emit('data',Buffer.from('SSH-2.0-OpenSSH_for_Windows\n'));
  await expect(windowsPending).resolves.toEqual({online:true,controlled:true,os:'windows',bootId:'windows-boot-id',defaultSystem:'cachyos'});

  run.mockReset();run.mockResolvedValue({stdout:JSON.stringify({os:'cachyos',mac:'02:00:00:00:00:01',bootId:'linux-boot-id',defaultSystem:'unknown'}),stderr:''});
  const linux=socket(),linuxPending=pcStatus();linux.emit('data',Buffer.from('SSH-2.0-OpenSSH_10\n'));
  await expect(linuxPending).resolves.toEqual({online:true,controlled:true,os:'cachyos',bootId:'linux-boot-id'});

  run.mockReset();run.mockResolvedValue({stdout:JSON.stringify({os:'windows',mac:'00:00:00:00:00:00',bootId:'windows-boot-id'}),stderr:''});
  const untrusted=socket(),untrustedPending=pcStatus();untrusted.emit('data',Buffer.from('SSH-2.0-OpenSSH_for_Windows\n'));
  await expect(untrustedPending).resolves.toEqual({online:true,controlled:false});
 });
 it('usa el SO fresco reportado para hacer una sola lectura SSH autenticada sin abrir antes un socket de banner',async()=>{
  run.mockReset();run.mockResolvedValue({stdout:JSON.stringify({os:'windows',mac:'02:00:00:00:00:01',bootId:'windows-boot-id'}),stderr:''});
  const unusedProbe=new FakeSocket();
  connect.mockReset().mockImplementation(()=>{queueMicrotask(()=>unusedProbe.emit('error',new Error('unexpected banner probe')));return unusedProbe as unknown as Socket;});
  await expect(pcStatus('windows')).resolves.toEqual({online:true,controlled:true,os:'windows',bootId:'windows-boot-id'});
  expect(run).toHaveBeenCalledTimes(1);expect(connect).not.toHaveBeenCalled();
 });
});
