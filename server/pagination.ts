import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import type { PageInfo } from './operational-types.js';
export class PageError extends Error {constructor(message='Cursor o filtros no válidos.'){super(message);}}
export type PageQuery={limit?:number;cursor?:string;q?:string;actor?:string;state?:string;type?:string;resourceId?:string;view?:string};
const schema=z.object({limit:z.union([z.number(),z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(1).max(100)).optional(),cursor:z.string().regex(/^[A-Za-z0-9_-]+$/).max(2048).optional(),q:z.string().max(160).optional(),actor:z.string().max(100).optional(),state:z.string().max(40).optional(),type:z.string().max(80).optional(),resourceId:z.string().min(1).max(220).optional(),view:z.string().max(40).optional()}).strict();
export function parsePageQuery(raw:unknown,defaultLimit=25):PageQuery {const result=schema.safeParse(raw);if(!result.success)throw new PageError();return {...result.data,limit:result.data.limit??defaultLimit,q:result.data.q?.trim()};}
export function requireChoice(value:string|undefined,choices:readonly string[]):void {if(value&&!choices.includes(value))throw new PageError();}
type Cursor={v:1;context:string;bound:number;last:number;expires:number};
type Sql={from:string;key:string;select:string;where?:string;params?:Array<string|number>};
/** Orden inmutable por clave de inserción. El cursor cifra el límite global y está ligado a ruta, filtros y autoridad. */
export class KeysetPages {
  private readonly key:Buffer;
  constructor(private readonly store:Store){
    let row=store.db.prepare("SELECT value FROM settings WHERE key='pagination-key-v1'").get() as {value:string}|undefined;
    if(!row){store.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('pagination-key-v1',?)").run(randomBytes(32).toString('hex'));row=store.db.prepare("SELECT value FROM settings WHERE key='pagination-key-v1'").get() as {value:string};}
    this.key=Buffer.from(row.value,'hex');if(this.key.length!==32)throw new Error('Invalid pagination key');
  }
  private encode(value:Cursor):string {const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');}
  private decode(token:string,context:string):Cursor {
    try{if(!/^[A-Za-z0-9_-]{40,2048}$/.test(token))throw new Error();const data=Buffer.from(token,'base64url');if(data.toString('base64url')!==token)throw new Error();const cipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));const value=JSON.parse(Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString()) as Cursor;
      if(value.v!==1||value.context!==context||!Number.isSafeInteger(value.bound)||!Number.isSafeInteger(value.last)||value.bound<0||value.last<0||value.last>value.bound+1||value.expires<=Date.now())throw new Error();return value;
    }catch{throw new PageError();}
  }
  page<T>(kind:string,authority:string,query:PageQuery,sql:Sql,project:(row:Record<string,unknown>)=>T|undefined):{items:T[]}&PageInfo {
    const parsed=parsePageQuery(query),{cursor,limit,...filters}=parsed;
    const context=createHash('sha256').update(JSON.stringify([kind,authority,filters])).digest('hex');
    const maximum=Number((this.store.db.prepare(`SELECT COALESCE(MAX(${sql.key}),0) AS maximum FROM ${sql.from}`).get() as {maximum:number}).maximum);
    const point=cursor?this.decode(cursor,context):{v:1 as const,context,bound:maximum,last:maximum+1,expires:Date.now()+30*60_000};
    const items:T[]=[],keys:number[]=[];let scan=point.last,hasMore=false;
    for(;;){
      const rows=this.store.db.prepare(`SELECT ${sql.key} AS pageKey,${sql.select} FROM ${sql.from} WHERE ${sql.key}<=? AND ${sql.key}<? ${sql.where?`AND (${sql.where})`:''} ORDER BY ${sql.key} DESC LIMIT 128`).all(point.bound,scan,...(sql.params??[])) as Array<Record<string,unknown>>;
      if(!rows.length)break;
      for(const row of rows){scan=Number(row.pageKey);const value=project(row);if(value===undefined)continue;if(items.length===limit){hasMore=true;break;}items.push(value);keys.push(scan);}
      if(hasMore||rows.length<128)break;
    }
    return {items,hasMore,nextCursor:hasMore?this.encode({...point,last:keys[keys.length-1]!}):null};
  }
}
