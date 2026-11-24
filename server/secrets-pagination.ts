import type { Store } from './store.js';
import type { SecretRequest, SecretGrant, SecretAuditEvent } from './secrets.js';
import { KeysetPages, requireChoice, type PageQuery } from './pagination.js';
export class SecretsPages {
  private readonly pages:KeysetPages;
  constructor(private readonly store:Store,private readonly get:(id:string)=>SecretRequest|undefined,private readonly now:()=>number){this.pages=new KeysetPages(store);}
  private expire():void {
    for(const value of this.store.db.prepare("SELECT id FROM secret_requests WHERE state IN ('pending','approved') AND expires_at<=? ORDER BY rowid").iterate(new Date(this.now()).toISOString()))this.get(String(value.id));
  }
  counts(){this.expire();const counts:Record<string,number>={pending:0,approved:0,denied:0,expired:0,delivered:0,failed:0};for(const value of this.store.db.prepare('SELECT state,COUNT(*) AS count FROM secret_requests GROUP BY state').iterate())counts[String(value.state)]=Number(value.count);return {counts};}
  requests(query:PageQuery,context:string){
    requireChoice(query.state,['pending','approved','denied','expired','delivered','failed']);this.expire();
    const where:string[]=[],params:Array<string|number>=[];
    if(query.state){where.push('r.state=?');params.push(query.state);}if(query.actor){where.push('r.agent=?');params.push(query.actor);}if(query.q){where.push("instr(lower(r.name||' '||r.project||' '||r.agent||' '||r.machine),?)>0");params.push(query.q.toLowerCase());}
    const page=this.pages.page('secret-requests',context,query,{from:'secret_requests r',key:'r.rowid',select:'r.id',where:where.join(' AND '),params},row=>this.get(String(row.id)));
    return {requests:page.items,nextCursor:page.nextCursor,hasMore:page.hasMore,pendingCount:Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM secret_requests WHERE state='pending'").get() as {count:number}).count)};
  }
  grants(query:PageQuery,context:string){
    requireChoice(query.state,['active','revoked','all']);const where:string[]=[],params:Array<string|number>=[];
    if(query.state!=='all')where.push(query.state==='revoked'?'g.revoked_at IS NOT NULL':'g.revoked_at IS NULL');
    if(query.actor){where.push('g.agent=?');params.push(query.actor);}if(query.type){where.push('g.scope=?');params.push(query.type);}if(query.q){where.push("instr(lower(g.name||' '||g.project||' '||g.agent||' '||g.machine),?)>0");params.push(query.q.toLowerCase());}
    const page=this.pages.page('secret-grants',context,query,{from:'secret_grants g',key:'g.rowid',select:'g.id,g.agent,g.machine,g.project,g.environment,g.name,g.scope,g.created_at AS createdAt',where:where.join(' AND '),params},row=>({id:String(row.id),agent:String(row.agent),machine:String(row.machine),project:String(row.project),environment:row.environment===null?null:String(row.environment),name:String(row.name),scope:row.scope as SecretGrant['scope'],createdAt:String(row.createdAt)}));
    return {grants:page.items,nextCursor:page.nextCursor,hasMore:page.hasMore};
  }
  audit(query:PageQuery,context:string){
    const where:string[]=[],params:Array<string|number>=[];
    if(query.actor){where.push('a.actor=?');params.push(query.actor);}if(query.type){where.push('a.event=?');params.push(query.type);}if(query.state){where.push('r.state=?');params.push(query.state);}if(query.q){where.push("instr(lower(a.event||' '||a.actor||' '||COALESCE(r.name,'')||' '||COALESCE(r.project,'')),?)>0");params.push(query.q.toLowerCase());}
    const page=this.pages.page<SecretAuditEvent>('secret-audit',context,query,{from:'secret_audit a LEFT JOIN secret_requests r ON r.id=a.request_id',key:'a.id',select:'a.id,a.at,a.request_id AS requestId,a.event,a.actor',where:where.join(' AND '),params},row=>({id:Number(row.id),at:String(row.at),requestId:row.requestId===null?null:String(row.requestId),event:String(row.event),actor:String(row.actor)}));
    return {events:page.items,nextCursor:page.nextCursor,hasMore:page.hasMore};
  }
}
