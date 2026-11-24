import { Resolver } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Store } from './store.js';
import type { CatalogRepository } from './catalog.js';
import type { ServiceProbeSignal, ServiceProbeTarget } from './types.js';

export type ProbeAddress = { address: string; family: 4 | 6 };
export type ProbeTarget = ServiceProbeTarget;

/** Current execution eligibility, shared by the application and monitor tests. */
export function resolveConfiguredProbeResource(catalog: CatalogRepository, configuredConnections: ReadonlySet<string>, configuredId: string, target?: ServiceProbeTarget): string | undefined {
  const records = catalog.listResources({ includeRetired: true });
  const find = (id: string) => id.startsWith('catalog:')
    ? records.find(record => record.catalogId === id.slice('catalog:'.length))
    : records.find(record => record.aliases.includes(id));
  const connectionActive = (id: string) => configuredConnections.has(id)
    && catalog.connections().some(connection => connection.id === id && connection.state === 'active');
  const record = find(configuredId);
  if (!record || record.lifecycle !== 'active' || !record.observedAt || !connectionActive(record.connectionId)
    || !catalog.isResourceReferenceActive(configuredId)) return undefined;
  if (target?.hostResourceId) {
    const hostId = target.hostResourceId;
    if (!catalog.isResourceReferenceActive(hostId)) return undefined;
    const host = find(hostId);
    if (host) {
      if (host.lifecycle !== 'active' || !connectionActive(host.connectionId)) return undefined;
    } else if (hostId.startsWith('catalog:')) return undefined;
    else {
      const [provider, alias] = hostId.split(':');
      if (provider === 'aws' || provider === 'coolify') {
        const connection = catalog.connectionByAlias(provider, alias ?? '')
          ?? catalog.connections().find(item => item.provider === provider && item.providerAccountId === alias);
        if (!connection || !connectionActive(connection.id)) return undefined;
      }
    }
  }
  return `catalog:${record.catalogId}`;
}
export type ProbeDependencies = {
  resolve: (hostname: string, signal: AbortSignal) => Promise<ProbeAddress[]>;
  request: (url: URL, address: ProbeAddress, timeoutMs: number) => Promise<number>;
};

const blockedIpv4: Array<[string, number]> = [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]
];

function ipv4Number(address: string): bigint | undefined {
  const parts=address.split('.');
  if(parts.length!==4||parts.some(part=>!/^\d{1,3}$/.test(part)||Number(part)>255))return undefined;
  return parts.reduce((result,part)=>(result<<8n)|BigInt(Number(part)),0n);
}

function ipv6Words(input: string): number[] | undefined {
  if(input.includes('%'))return undefined;
  let address=input.toLowerCase();
  const halves=address.split('::');
  if(halves.length>2)return undefined;
  const parsePart=(part:string):number[]|undefined=>{
    if(!part)return [];
    const chunks=part.split(':');
    if(chunks.some(chunk=>!chunk))return undefined;
    const result:number[]=[];
    for(let index=0;index<chunks.length;index++){
      const chunk=chunks[index]!;
      if(chunk.includes('.')){
        if(index!==chunks.length-1)return undefined;
        const ipv4=ipv4Number(chunk);if(ipv4===undefined)return undefined;
        result.push(Number((ipv4>>16n)&0xffffn),Number(ipv4&0xffffn));
      }else{
        if(!/^[a-f0-9]{1,4}$/.test(chunk))return undefined;
        result.push(Number.parseInt(chunk,16));
      }
    }
    return result;
  };
  const left=parsePart(halves[0]??''),right=parsePart(halves[1]??'');
  if(!left||!right)return undefined;
  if(halves.length===1)return left.length===8?left:undefined;
  const missing=8-left.length-right.length;
  if(missing<1)return undefined;
  return [...left,...Array.from({length:missing},()=>0),...right];
}

export function isPublicAddress(address: string): boolean {
  const family=isIP(address);
  if(family===4){
    const value=ipv4Number(address);if(value===undefined)return false;
    return !blockedIpv4.some(([base,prefix])=>{
      const network=ipv4Number(base)!;
      return (value>>(32n-BigInt(prefix)))===(network>>(32n-BigInt(prefix)));
    });
  }
  if(family!==6)return false;
  const words=ipv6Words(address);if(!words)return false;
  const first=words[0]!,second=words[1]!;
  // Only global unicast 2000::/3 is eligible. Exclude transition, special-use,
  // documentation, and 6to4 ranges even when a resolver returns them.
  if(first<0x2000||first>0x3fff||first===0x2002||first===0x3fff)return false;
  if(first===0x2001&&(second<0x0200||second===0x0db8))return false;
  return true;
}

export function isSafeServiceProbeUrl(value: string): boolean {
  try{
    if(/[\u0000-\u0020\u007f]/.test(value))return false;
    const url=new URL(value),hostname=url.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'');
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port&&url.port!=='443')return false;
    if(isIP(hostname)!==0||!hostname.includes('.')||hostname.length>253)return false;
    if(hostname.split('.').some(label=>!label||label.length>63||label.startsWith('-')||label.endsWith('-')))return false;
    if(/\.(localhost|local|lan|home|internal|test|invalid|example)$/.test(hostname))return false;
    return true;
  }catch{return false;}
}

async function resolveAddresses(hostname:string,signal:AbortSignal):Promise<ProbeAddress[]> {
  if(signal.aborted)throw Object.assign(new Error('probe timeout'),{code:'ETIMEDOUT'});
  const resolver=new Resolver(),cancel=()=>resolver.cancel();
  signal.addEventListener('abort',cancel,{once:true});
  try{
    const [ipv4,ipv6]=await Promise.allSettled([resolver.resolve4(hostname),resolver.resolve6(hostname)]);
    if(signal.aborted)throw Object.assign(new Error('probe timeout'),{code:'ETIMEDOUT'});
    const addresses:ProbeAddress[]=[
      ...(ipv4.status==='fulfilled'?ipv4.value.map(address=>({address,family:4 as const})):[]),
      ...(ipv6.status==='fulfilled'?ipv6.value.map(address=>({address,family:6 as const})):[])
    ];
    if(addresses.length)return addresses;
    const failure=ipv4.status==='rejected'?ipv4.reason:ipv6.status==='rejected'?ipv6.reason:undefined;
    throw failure??new Error('No public service address records');
  }finally{
    signal.removeEventListener('abort',cancel);
  }
}

export function pinnedAddressLookup(address:ProbeAddress):LookupFunction {
  return ((_hostname:string,options:unknown,callback:(...args:any[])=>void)=>{
    if(typeof options==='object'&&options!==null&&'all'in options&&(options as {all?:boolean}).all)callback(null,[address]);
    else callback(null,address.address,address.family);
  }) as unknown as LookupFunction;
}

export function pinnedHttpsStatus(url:URL,address:ProbeAddress,timeoutMs:number,requester:typeof httpsRequest=httpsRequest):Promise<number> {
  return new Promise((resolve,reject)=>{
    let settled=false;
    let timer:NodeJS.Timeout|undefined;
    const finish=(error:Error|undefined,status?:number)=>{
      if(settled)return;
      settled=true;
      if(timer)clearTimeout(timer);
      if(error)reject(error);else resolve(status??0);
    };
    const request=requester({
      hostname:url.hostname,port:443,path:url.pathname,method:'GET',servername:url.hostname,
      rejectUnauthorized:true,agent:false,lookup:pinnedAddressLookup(address),maxHeaderSize:8192,
      headers:{Accept:'*/*','User-Agent':'Infra-Control-health-probe/1.0',Connection:'close'}
    },response=>{
      const status=response.statusCode??0;
      response.on('error',()=>{});
      response.destroy();
      finish(undefined,status);
    });
    request.on('error',error=>finish(error));
    timer=setTimeout(()=>{
      const error=Object.assign(new Error('probe timeout'),{code:'ETIMEDOUT'});
      request.destroy(error);
    },timeoutMs);
    timer.unref();
    request.end();
  });
}

const productionDependencies:ProbeDependencies={resolve:resolveAddresses,request:pinnedHttpsStatus};
function signal(state:ServiceProbeSignal['state'],reasonCode:string,observedAt:string,freshUntil:string,evidence?:string):ServiceProbeSignal {
  return {state,source:'https-probe',observedAt,freshUntil,reasonCode,...(evidence?{evidence}:{})};
}

function withinDeadline<T>(operation:Promise<T>,timeoutMs:number,onTimeout?:()=>void):Promise<T> {
  return new Promise((resolve,reject)=>{
    const timeout=Object.assign(new Error('probe timeout'),{code:'ETIMEDOUT'});
    const timer=setTimeout(()=>{onTimeout?.();reject(timeout);},timeoutMs);
    operation.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}

export async function probeTarget(target:ServiceProbeTarget,dependencies:ProbeDependencies=productionDependencies,now=Date.now(),eligible:()=>boolean=()=>true):Promise<ServiceProbeSignal> {
  const observedAt=new Date(now).toISOString(),freshUntil=new Date(now+target.intervalSeconds*2_000).toISOString();
  if(!eligible())return signal('unknown','probe_ineligible',observedAt,freshUntil);
  if(!isSafeServiceProbeUrl(target.url))return signal('unknown','probe_config_invalid',observedAt,freshUntil);
  const url=new URL(target.url),deadline=Date.now()+target.timeoutMs;
  let addresses:ProbeAddress[];
  try{
    const remaining=deadline-Date.now();if(remaining<=0)throw Object.assign(new Error('probe timeout'),{code:'ETIMEDOUT'});
    const controller=new AbortController();
    if(!eligible())return signal('unknown','probe_ineligible',observedAt,freshUntil);
    addresses=await withinDeadline(dependencies.resolve(url.hostname,controller.signal),remaining,()=>controller.abort());
  }catch(error){
    const code=error&&typeof error==='object'&&'code'in error?(error as {code?:unknown}).code:undefined;
    return signal('unknown',code==='ETIMEDOUT'?'probe_timeout':'probe_dns_failed',observedAt,freshUntil);
  }
  if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)||item.family!==isIP(item.address)))return signal('unknown','probe_destination_blocked',observedAt,freshUntil);
  const selected=addresses.find(item=>item.family===4)??addresses[0]!;
  try{
    const remaining=deadline-Date.now();if(remaining<=0)throw Object.assign(new Error('probe timeout'),{code:'ETIMEDOUT'});
    if(!eligible())return signal('unknown','probe_ineligible',observedAt,freshUntil);
    const status=await withinDeadline(dependencies.request(url,selected,remaining),remaining);
    return target.expectedStatusCodes.includes(status)
      ?signal('healthy','probe_http_ok',observedAt,freshUntil,`HTTP ${status}`)
      :signal('unhealthy','probe_unexpected_http_status',observedAt,freshUntil,`HTTP ${status}`);
  }catch(error){
    const code=error&&typeof error==='object'&&'code'in error?(error as {code?:unknown}).code:undefined;
    return signal('unknown',code==='ETIMEDOUT'?'probe_timeout':'probe_request_failed',observedAt,freshUntil);
  }
}

export type ProbeRunner=(target:ServiceProbeTarget,now:number,eligible?:()=>boolean)=>Promise<ServiceProbeSignal>;
export class ServiceProbeMonitor {
  private timer?:NodeJS.Timeout;
  private closed=false;
  private running=false;
  constructor(
    private readonly targets:readonly ServiceProbeTarget[],
    private readonly store:Store,
    private readonly resolveResource:(configuredId:string,target?:ServiceProbeTarget)=>string|undefined,
    private readonly onStateChange:(resourceId:string)=>void,
    private readonly runProbe:ProbeRunner=(target,now,eligible)=>probeTarget(target,productionDependencies,now,eligible),
    private readonly now:()=>number=Date.now
  ){}
  start():void {
    if(this.closed||this.timer||!this.targets.length)return;
    this.timer=setInterval(()=>{void this.tick();},5_000);
    this.timer.unref();
    void this.tick();
  }
  close():void {this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  async tick():Promise<void> {
    if(this.closed||this.running||!this.targets.length)return;
    this.running=true;
    try{
      const now=this.now(),seen=new Set<string>(),due=this.targets.flatMap(target=>{
        const resourceId=this.resolveResource(target.resourceId,target);
        if(!resourceId||seen.has(resourceId))return [];
        seen.add(resourceId);
        const hostId=target.hostResourceId??resourceId;
        if(this.store.probeLifecycle.evaluate(resourceId,target.resourceId,hostId,now,Math.max(120_000,target.intervalSeconds*2000)))this.onStateChange(resourceId);
        if(this.store.probeLifecycle.maintenance(resourceId,hostId))return [];
        const previous=this.store.serviceProbe(resourceId);
        return previous&&!this.store.probeLifecycle.needsProbe(resourceId)&&now-Date.parse(previous.observedAt)<target.intervalSeconds*1000?[]:[{target,resourceId}];
      });
      for(let index=0;index<due.length;index+=2){
        if(this.closed)return;
        const batch=due.slice(index,index+2);
        await Promise.all(batch.map(async({target,resourceId})=>{
          if(this.closed)return;
          try{
            const eligible=()=>!this.closed&&this.resolveResource(target.resourceId,target)===resourceId
              &&!this.store.probeLifecycle.maintenance(resourceId,target.hostResourceId??resourceId);
            if(!eligible())return;
            const observed=await this.runProbe(target,now,eligible);
            if(!eligible())return;
            if(this.store.recordServiceProbe(resourceId,observed,this.now(),target.resourceId,target.hostResourceId??resourceId))this.onStateChange(resourceId);
          }catch{/* A failed probe or storage write leaves the last known result to expire as unknown. */}
        }));
      }
    }catch{/* Configuration/catalog read failures leave the last result intact and allow the next tick to retry. */}
    finally{this.running=false;}
  }
}
