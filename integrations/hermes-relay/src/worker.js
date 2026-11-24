import { DurableObject } from 'cloudflare:workers';

const CHUNK = 65536, UPLOAD_MAX = 32 * 1024 ** 2, DOWNLOAD_MAX = 128 * 1024 ** 2, FRAME_MAX = 1024 ** 2;
const enc = new TextEncoder(), dec = new TextDecoder();
const hop = new Set(['connection','upgrade','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-accept']);
const reply = (status, message) => new Response(message, {status, headers:{'Cache-Control':'no-store'}});
async function authorized(value, secret) {
  if (!secret || !value || value.length > 512) return false;
  const [a,b] = await Promise.all([value,secret].map(s => crypto.subtle.digest('SHA-256',enc.encode(s))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i=0;i<aa.length;i++) diff |= aa[i]^bb[i];
  return diff === 0;
}
function headersFor(request) {
  const out = [];
  for (const [key,value] of request.headers) {
    if (!hop.has(key) && !key.startsWith('cf-') && !['host','x-hermes-relay-key','x-forwarded-for','x-forwarded-host','x-forwarded-proto','forwarded','accept-encoding'].includes(key)) out.push([key,value]);
  }
  out.push(['host',new URL(request.url).host],['x-forwarded-proto','https']);
  return out;
}
function pack(kind,id,bytes) {
  const data = typeof bytes === 'string' ? enc.encode(bytes) : new Uint8Array(bytes);
  const out = new Uint8Array(37+data.byteLength);
  out[0]=kind; out.set(enc.encode(id),1); out.set(data,37);
  return out;
}
function unpack(data) {
  const bytes = new Uint8Array(data);
  if (bytes.length<37 || bytes.length>FRAME_MAX+37) throw new Error('frame');
  const id = dec.decode(bytes.subarray(1,37));
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('id');
  return {kind:bytes[0],id,bytes:bytes.slice(37)};
}
function deferred(ms = 0) {
  let yes, no, timer, settled = false;
  const promise = new Promise((resolve, reject) => { yes = resolve; no = reject; });
  promise.catch(() => {});
  const result = {
    promise,
    arm: timeout => {
      if (!settled && !timer) timer = setTimeout(() => result.reject(new Error('timeout')), timeout);
    },
    resolve: value => { if (!settled) { settled = true; clearTimeout(timer); yes(value); } },
    reject: error => { if (!settled) { settled = true; clearTimeout(timer); no(error); } }
  };
  if (ms) result.arm(ms);
  return result;
}

export default {
  async fetch(request,env) {
    const connector = new URL(request.url).pathname === '/_relay/connect';
    const key = connector ? request.headers.get('Authorization')?.replace(/^Bearer /,'') : request.headers.get('X-Hermes-Relay-Key');
    if (!await authorized(key,connector?env.CONNECTOR_KEY:env.CLIENT_KEY)) return reply(401,'Unauthorized');
    return env.RELAY.get(env.RELAY.idFromName('windows')).fetch(request);
  }
};
export class Relay extends DurableObject {
  constructor(ctx,env) {super(ctx,env);this.pending=new Map();}
  connector() {return this.ctx.getWebSockets('connector').find(ws=>ws.readyState===1);}
  control(ws,m) {ws.send(JSON.stringify(m));}
  fail(id,reason='Transport unavailable') {
    const p=this.pending.get(id);
    if(!p)return;
    this.pending.delete(id);p.head.reject(new Error(reason));p.ack?.reject(new Error(reason));
    try {p.stream?.error(new Error(reason));} catch {}
    p.reader?.cancel().catch(()=>{});
  }
  async fetch(request) {
    if(new URL(request.url).pathname==='/_relay/connect') {
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return reply(426,'WebSocket required');
      for(const old of this.ctx.getWebSockets('connector')) {this.disconnect(old);old.serializeAttachment({role:'retired'});try{old.close(1001,'Replaced');}catch{}}
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1],['connector']);pair[1].serializeAttachment({role:'connector'});
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    const socket=this.connector();
    if(!socket)return reply(503,'Windows offline');
    if(this.pending.size>=12 || this.ctx.getWebSockets('client').length>=8)return reply(429,'Relay busy');
    const upgrade=request.headers.get('Upgrade')?.toLowerCase()==='websocket';
    const declared=request.headers.get('content-length');
    if(declared && (!/^\d+$/.test(declared)||Number(declared)>UPLOAD_MAX))return reply(413,'Upload limit: 32 MiB');
    const id=crypto.randomUUID();
    const p={head:deferred(upgrade ? 60000 : 0),bytes:0,credit:false,reader:null,stream:null,ack:null};
    this.pending.set(id,p);
    const abort=()=>{try{this.control(socket,{t:'cancel',id});}catch{}this.fail(id,'Client disconnected');};
    request.signal.addEventListener('abort',abort,{once:true});
    try {
      this.control(socket,{t:'request',id,ws:upgrade,method:request.method,path:new URL(request.url).pathname+new URL(request.url).search,headers:headersFor(request)});
      if(!upgrade) {
        let uploaded=0;
        if(request.body) {
          p.reader=request.body.getReader();
          while(true) {
            const {value,done}=await p.reader.read();if(done)break;
            uploaded+=value.length;if(uploaded>UPLOAD_MAX)throw new Error('upload limit');
            for(let pos=0;pos<value.length;pos+=CHUNK) {
              p.ack=deferred(30000);socket.send(pack(0,id,value.subarray(pos,pos+CHUNK)));await p.ack.promise;
            }
          }
        }
        this.control(socket,{t:'upload_end',id});
        p.head.arm(60000);
      }
      const head=await p.head.promise;
      if(upgrade && head.t==='ws_open') {
        const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1],['client',`client:${id}`]);pair[1].serializeAttachment({role:'client',id,outstanding:0});
        this.pending.delete(id);const headers=new Headers();if(head.protocol)headers.set('Sec-WebSocket-Protocol',head.protocol);
        return new Response(null,{status:101,webSocket:pair[0],headers});
      }
      const headers=new Headers();
      for(const [key,value] of head.headers)if(!hop.has(key.toLowerCase()))headers.append(key,value);
      headers.set('Cache-Control','no-store');
      if(request.method==='HEAD'||[204,205,304].includes(head.status)) {
        this.pending.delete(id);this.control(socket,{t:'cancel',id});return new Response(null,{status:head.status,headers});
      }
      const stream=new ReadableStream({
        start:controller=>{p.stream=controller;},
        pull:()=>{if(!p.credit && this.pending.has(id)){p.credit=true;this.control(socket,{t:'pull',id});}},
        cancel:()=>{this.pending.delete(id);this.control(socket,{t:'cancel',id});}
      },{highWaterMark:CHUNK,size:chunk=>chunk.length});
      return new Response(stream,{status:head.status,headers,encodeBody:'manual'});
    }catch(error) {
      try{this.control(socket,{t:'cancel',id});}catch{}this.fail(id);
      return reply(error.message==='upload limit'?413:502,'Relay request interrupted; not retried');
    }finally{request.signal.removeEventListener('abort',abort);}
  }
  webSocketMessage(ws,message) {
    const who=ws.deserializeAttachment();
    if(!who || !['client','connector'].includes(who.role))return;
    try {
      if(who.role==='client') {
        const size=typeof message==='string'?enc.encode(message).length:message.byteLength;
        if(size>FRAME_MAX||who.outstanding>=8){ws.close(1009,'Frame or backlog limit');return;}
        const connector=this.connector();if(!connector){ws.close(1011,'Windows offline');return;}
        who.outstanding++;ws.serializeAttachment(who);connector.send(pack(typeof message==='string'?2:3,who.id,message));return;
      }
      if(typeof message!=='string') {
        const {kind,id,bytes}=unpack(message);
        if(kind===1) {
          const p=this.pending.get(id);if(!p)return;
          if(!p.credit||!p.stream||bytes.length>CHUNK||p.bytes+bytes.length>DOWNLOAD_MAX){this.fail(id,'Download limit or protocol error');this.control(ws,{t:'cancel',id});return;}
          p.credit=false;p.bytes+=bytes.length;p.stream.enqueue(bytes);
          if(!p.credit && p.stream.desiredSize>0){p.credit=true;this.control(ws,{t:'pull',id});}
        }else if(kind===2||kind===3) {
          for(const client of this.ctx.getWebSockets(`client:${id}`))client.send(kind===2?dec.decode(bytes):bytes);
        }else throw new Error('kind');
        return;
      }
      if(message.length>65536)throw new Error('control size');
      const m=JSON.parse(message),p=this.pending.get(m.id);
      if(m.t==='headers'||m.t==='ws_open')p?.head.resolve(m);
      else if(m.t==='upload_ack')p?.ack?.resolve();
      else if(m.t==='end'){if(p){p.stream?.close();this.pending.delete(m.id);}}
      else if(m.t==='error'){this.fail(m.id);for(const c of this.ctx.getWebSockets(`client:${m.id}`))c.close(1011,'Backend unavailable');}
      else if(m.t==='ws_close'){for(const c of this.ctx.getWebSockets(`client:${m.id}`))c.close(1000,'Backend closed');}
      else if(m.t==='ws_ack'){for(const c of this.ctx.getWebSockets(`client:${m.id}`)){const a=c.deserializeAttachment();a.outstanding=Math.max(0,a.outstanding-1);c.serializeAttachment(a);}}
      else throw new Error('control');
    }catch{this.disconnect(ws);try{ws.close(1008,'Protocol error');}catch{}}
  }
  disconnect(ws) {
    const who=ws.deserializeAttachment();
    if(who?.role==='connector') {
      for(const id of this.pending.keys())this.fail(id);
      for(const c of this.ctx.getWebSockets('client'))try{c.close(1011,'Windows disconnected');}catch{}
    }else if(who?.role==='client') {
      const connector=this.connector();if(connector)try{this.control(connector,{t:'cancel',id:who.id});}catch{}
    }
  }
  webSocketClose(ws){this.disconnect(ws);try{ws.close(1000,'Closed');}catch{}}
  webSocketError(ws){this.disconnect(ws);}
}
