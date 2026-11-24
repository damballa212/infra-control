import { describe, expect, it } from 'vitest';
import { OtlpMetricsError, parseOtlpMetrics } from '../server/otel-metrics.js';

const timestamp=(milliseconds:number)=>String(BigInt(milliseconds)*1_000_000n);
function payload(hostId='host-home-vps',observedAt=Date.now()):unknown {
  const timeUnixNano=timestamp(observedAt);
  const point=(attributes:Record<string,string>,value:number|string)=>({timeUnixNano,attributes:Object.entries(attributes).map(([key,stringValue])=>({key,value:{stringValue}})),...(typeof value==='number'?{asDouble:value}:{asInt:value})});
  return {resourceMetrics:[{resource:{attributes:[{key:'host.id',value:{stringValue:hostId}}]},scopeMetrics:[{metrics:[
    {name:'system.cpu.utilization',gauge:{dataPoints:[
      point({cpu:'0',state:'user'},0.2),point({cpu:'0',state:'system'},0.1),point({cpu:'0',state:'idle'},0.7),
      point({cpu:'1',state:'user'},0.4),point({cpu:'1',state:'system'},0.1),point({cpu:'1',state:'idle'},0.5)
    ]}},
    {name:'system.memory.utilization',gauge:{dataPoints:[point({state:'used'},0.6),point({state:'free'},0.4)]}},
    {name:'system.memory.usage',sum:{dataPoints:[point({state:'used'},'600'),point({state:'free'},'400')]}},
    {name:'system.memory.limit',gauge:{dataPoints:[point({},'1000')]}},
    {name:'system.filesystem.utilization',gauge:{dataPoints:[point({device:'/dev/root',mountpoint:'/'},0.75)]}},
    {name:'system.network.io',sum:{dataPoints:[point({device:'eth0',direction:'receive'},'1000'),point({device:'eth0',direction:'transmit'},'2000')]}}
  ]}]}]};
}

type TestOtlpResourceMetric={resource:{attributes:Array<{key:string;value:{stringValue:string}}>};scopeMetrics:Array<{metrics:unknown[]}>};
function threeResourceMetrics():{resourceMetrics:TestOtlpResourceMetric[]} {
  const body=structuredClone(payload()) as {resourceMetrics:TestOtlpResourceMetric[]};
  const original=body.resourceMetrics[0]!;
  const metrics=original.scopeMetrics[0]!.metrics;
  body.resourceMetrics=[metrics.slice(0,2),metrics.slice(2,4),metrics.slice(4)].map(group=>({
    resource:structuredClone(original.resource),scopeMetrics:[{metrics:group}]
  }));
  return body;
}

describe('adaptador acotado de métricas OTLP/HTTP JSON',()=>{
  it('calcula métricas host con timestamp real sin tratar la hora de recepción como observación',()=>{
    const observedAt=Date.now()-30_000;
    const sample=parseOtlpMetrics(payload('host-home-vps',observedAt),'host-home-vps',Date.now());
    expect(sample.cpu).toMatchObject({percent:40,observedAt:new Date(observedAt).toISOString()});
    expect(sample.memory).toMatchObject({usedBytes:600,totalBytes:1000,utilizationPercent:60});
    expect(sample.filesystems).toEqual([expect.objectContaining({device:'/dev/root',mountpoint:'/',utilizationPercent:75})]);
    expect(sample.network).toEqual([expect.objectContaining({device:'eth0',receivedBytes:1000,sentBytes:2000})]);
  });

  it('agrega métricas del Collector repartidas en varios resourceMetrics del mismo host',()=>{
    const sample=parseOtlpMetrics(threeResourceMetrics(),'host-home-vps',Date.now());
    expect(sample.cpu?.percent).toBe(40);
    expect(sample.memory?.usedBytes).toBe(600);
    expect(sample.filesystems?.[0]?.mountpoint).toBe('/');
    expect(sample.network?.[0]?.receivedBytes).toBe(1000);
  });

  it('rechaza un lote que mezcla identidades de host aunque una de ellas sea válida',()=>{
    const body=threeResourceMetrics();
    body.resourceMetrics[1]!.resource.attributes[0]!.value.stringValue='host-other';
    let error:unknown;
    try{parseOtlpMetrics(body,'host-home-vps',Date.now());}catch(caught){error=caught;}
    expect(error).toMatchObject({code:'host_identity_mismatch'});
  });

  it('mantiene un límite explícito al número de resourceMetrics',()=>{
    const body=threeResourceMetrics();
    body.resourceMetrics=Array.from({length:9},()=>structuredClone(body.resourceMetrics[0]!));
    let error:unknown;
    try{parseOtlpMetrics(body,'host-home-vps',Date.now());}catch(caught){error=caught;}
    expect(error).toMatchObject({code:'metric_limit_exceeded'});
  });

  it('cuenta también los datapoints de métricas OTLP que el adaptador no consume',()=>{
    const body=payload() as {resourceMetrics:{scopeMetrics:{metrics:unknown[]}[]}[]};
    body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.push({
      name:'system.processes.count',gauge:{dataPoints:Array.from({length:513},()=>({}))}
    });
    let error:unknown;
    try{parseOtlpMetrics(body,'host-home-vps',Date.now());}catch(caught){error=caught;}
    expect(error).toMatchObject({code:'metric_limit_exceeded'});
  });

  it('rechaza identidad ajena, timestamp futuro y métricas fuera del presupuesto',()=>{
    expect(()=>parseOtlpMetrics(payload('another-host'),'host-home-vps',Date.now())).toThrowError(OtlpMetricsError);
    expect(()=>parseOtlpMetrics(payload('host-home-vps',Date.now()+10*60_000),'host-home-vps',Date.now())).toThrowError(OtlpMetricsError);
    const oversized=payload() as {resourceMetrics:{scopeMetrics:{metrics:{name:string;gauge:{dataPoints:unknown[]}}[]}[]}[]};
    oversized.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.gauge.dataPoints=Array.from({length:600},()=>({timeUnixNano:timestamp(Date.now()),asDouble:0.1}));
    expect(()=>parseOtlpMetrics(oversized,'host-home-vps',Date.now())).toThrowError(OtlpMetricsError);
  });

  it('conserva la observación más reciente cuando los puntos del host tienen horas distintas',()=>{
    const earlier=Date.now()-60_000,later=Date.now()-5_000;
    const body=payload('host-home-vps',earlier) as {resourceMetrics:{scopeMetrics:{metrics:{name:string;gauge:{dataPoints:{timeUnixNano:string}[]}}[]}[]}[]};
    body.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.gauge.dataPoints[0]!.timeUnixNano=timestamp(later);
    const sample=parseOtlpMetrics(body,'host-home-vps',Date.now());
    expect(sample.cpu?.observedAt).toBe(new Date(later).toISOString());
  });
});
