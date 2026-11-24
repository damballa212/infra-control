import { describe, expect, it } from 'vitest';
import { parseConfig } from '../server/config.js';
import { tokenHash } from '../server/auth.js';

const base={
  origin:'https://control.example.test',passwordHash:'argon2-hash',agentTokens:[],aws:[],coolify:{url:'',token:'',resources:[]},acs:{url:'',deviceId:''}
};

describe('configuración validada de agentes',()=>{
  it('conserva las políticas explícitas de lectura, tools y operaciones',()=>{
    const config=parseConfig({...base,agentTokens:[{name:'rakazo',hash:tokenHash('agent-secret'),scopes:['read','operate'],
      mcpTools:['list_resources','plan_operation','execute_operation'],readPolicy:{accountIds:['123456789012'],costs:true},
      operationPolicy:{actions:['stop'],catalogIds:['catalog-1']}}]});
    expect(config.agentTokens[0]).toMatchObject({name:'rakazo',mcpTools:['list_resources','plan_operation','execute_operation'],readPolicy:{accountIds:['123456789012'],costs:true},operationPolicy:{actions:['stop'],catalogIds:['catalog-1']}});
  });

  it('rechaza scopes, nombres, hash o acciones inválidas en vez de iniciar con reglas ambiguas',()=>{
    expect(()=>parseConfig({...base,agentTokens:[{name:'bad',hash:'short',scopes:['operate'],operationPolicy:{actions:['shell']}}]})).toThrow('Invalid server configuration');
    expect(()=>parseConfig({...base,agentTokens:[{name:'bad',hash:tokenHash('agent-secret'),scopes:['read'],operationPolicy:{actions:['shell']}}]})).toThrow('Invalid server configuration');
    expect(()=>parseConfig({...base,agentTokens:[{name:'same',hash:tokenHash('agent-secret'),scopes:['read']},{name:'same',hash:tokenHash('other-secret'),scopes:['read']}]})).toThrow('Invalid server configuration');
  });
  it('liga cada identidad de OTel a un recurso y a una credencial única',()=>{
    const collector={hostId:'host-home-vps',resourceId:'aws:prod:i-hostmetrics',tokenHash:tokenHash('one-host-private-token')};
    expect(parseConfig({...base,otelCollectors:[collector]}).otelCollectors).toEqual([collector]);
    expect(()=>parseConfig({...base,otelCollectors:[collector,{...collector,hostId:'another-host-id'}]})).toThrow('Invalid server configuration');
  });
  it('acepta sondas solo para destinos HTTPS explícitos con parámetros acotados',()=>{
    const target={resourceId:'catalog:prod-service',url:'https://health.example.com/ready',expectedStatusCodes:[200,204]};
    expect(parseConfig({...base,serviceProbes:[target]}).serviceProbes).toEqual([{...target,intervalSeconds:60,timeoutMs:3000}]);
  });
  it('valida servicios lógicos y exige procedencia explícita para cada relación física',()=>{
    const service={key:'cms',name:'CMS',projectKey:'shop',projectName:'shop',environment:'production',relations:[{resourceId:'aws:prod:i-cms',relationType:'hosted_on',evidence:'operator_confirmed'}]};
    expect(parseConfig({...base,services:[service]}).services).toEqual([{...service,criticality:'normal'}]);
    expect(()=>parseConfig({...base,services:[service,{...service,name:'CMS duplicate'}]})).toThrow('Invalid server configuration');
    expect(()=>parseConfig({...base,services:[{...service,projectName:undefined}]})).toThrow('Invalid server configuration');
    expect(()=>parseConfig({...base,services:[{...service,relations:[{resourceId:'aws:prod:i-cms',relationType:'hosted_on',evidence:'inferred_by_name'}]}]})).toThrow('Invalid server configuration');
  });
  it('rechaza destinos HTTP, locales, con puerto alterno o con query',()=>{
    for(const url of ['http://health.example.com/ready','https://localhost/ready','https://127.0.0.1/ready','https://health.example.com:8443/ready','https://health.example.com/ready?token=secret']){
      expect(()=>parseConfig({...base,serviceProbes:[{resourceId:'catalog:prod-service',url}]})).toThrow('Invalid server configuration');
    }
  });
  it('rechaza múltiples sondas del mismo recurso o intervalos demasiado agresivos',()=>{
    const target={resourceId:'catalog:prod-service',url:'https://health.example.com/ready'};
    expect(()=>parseConfig({...base,serviceProbes:[target,{...target,url:'https://status.example.com/health'}]})).toThrow('Invalid server configuration');
    expect(()=>parseConfig({...base,serviceProbes:[{...target,intervalSeconds:1}]})).toThrow('Invalid server configuration');
    expect(()=>parseConfig({...base,serviceProbes:[{...target,resourceId:'catalog: bad'}]})).toThrow('Invalid server configuration');
  });
});

describe('configuración de la bóveda de secretos', () => {
  const vault = { kind: 'vaultwarden', serverUrl: 'https://vault.example.test', email: 'broker@vault.example.test', password: 'x'.repeat(40), organizationId: '6e5e16f0-920d-4edd-8767-6fa9970785ec' };
  it('acepta Vaultwarden por https y políticas con comodín único', () => {
    const config = parseConfig({ ...base, secretsVault: vault, agentTokens: [{ name: 'claude-ec2', hash: tokenHash('t'), scopes: ['read', 'operate'], secretsPolicy: { projects: ['*'] } }] });
    expect(config.secretsVault?.serverUrl).toBe('https://vault.example.test');
    expect(config.agentTokens[0]?.secretsPolicy).toEqual({ projects: ['*'] });
  });
  it('rechaza http, campos desconocidos, contraseña corta y el comodín mezclado con proyectos', () => {
    for (const bad of [{ ...vault, serverUrl: 'http://vault.example.test' }, { ...vault, extra: 1 }, { ...vault, password: 'corta' }, { ...vault, organizationId: 'no-uuid' }])
      expect(() => parseConfig({ ...base, secretsVault: bad })).toThrow('Invalid server configuration');
    expect(() => parseConfig({ ...base, agentTokens: [{ name: 'a', hash: tokenHash('t'), scopes: ['read', 'operate'], secretsPolicy: { projects: ['*', 'p'] } }] })).toThrow('Invalid server configuration');
  });
});
