import { test, expect } from "@playwright/test";
import type { Operation } from "../ui/src/contract.ts";
import { makeResources, makeCosts } from "../states/fixtures.ts";
async function holdConfirm(page: import('@playwright/test').Page) {
  const key = page.getByRole('button', { name: /Mantén pulsado/ });
  const box = (await key.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1700);
  await page.mouse.up();
}
test.use({ baseURL: "http://127.0.0.1:4176" });
test("build HTTP: sesión,202incierto y PWA sin caché de datos privados", async ({
  page,
  context,
}) => {
  let signedIn = false;
  let writes = 0;
  let saved: Operation | null = null;
  const anchor = Date.parse("2026-10-21T03:42:00Z");
  const resources = makeResources(anchor);
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/login") {
      signedIn = true;
      await route.fulfill({
        json: { name: "Admin" },
        headers: { "Cache-Control": "no-store" },
      });
      return;
    }
    if (!signedIn) {
      await route.fulfill({
        status: 401,
        json: { error: "Sesión requerida" },
        headers: { "Cache-Control": "no-store" },
      });
      return;
    }
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: { name: "Admin" },
        headers: { "Cache-Control": "no-store" },
      });
      return;
    }
    if (url.pathname === "/api/resources") {
      await route.fulfill({
        json: {
          resources,
          fetchedAt: new Date(anchor).toISOString(),
          refreshSeconds: 60,
        },
        headers: { "Cache-Control": "no-store" },
      });
      return;
    }
    if (url.pathname === "/api/auth/logout") {
      signedIn = false;
      await route.fulfill({ status: 401, json: { error: "Sesión caducada" } });
      return;
    }
    if (
      url.pathname === "/api/operations" &&
      route.request().method() === "POST"
    ) {
      writes++;
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      saved = {
        id: "real-contract-order",
        resourceId: resources[0]!.id,
        resourceName: resources[0]!.name,
        action: "stop",
        actor: "admin",
        state: "uncertain",
        message: "AWS no confirmó la recepción de la orden.",
        createdAt: new Date(anchor).toISOString(),
        updatedAt: new Date(anchor).toISOString(),
      };
      await route.fulfill({
        status: 202,
        json: saved,
        headers: { "Cache-Control": "no-store" },
      });
      return;
    }
    if (url.pathname.startsWith("/api/operations/") && saved) {
      await route.fulfill({ json: saved });
      return;
    }
    if (url.pathname === "/api/operations") {
      await route.fulfill({
        json: { operations: saved ? [saved] : [] },
        headers: { "Cache-Control": "no-store" },
      });
      return;
    }
    if (url.pathname === "/api/costs") {
      await route.fulfill({
        json: makeCosts(anchor),
        headers: { "Cache-Control": "no-store" },
      });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { error: "No existe" },
      headers: { "Cache-Control": "no-store" },
    });
  });
  await page.goto("/?s=normal");
  await expect(
    page.getByRole("heading", { name: "Entrar", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("PROTOTIPO · datos simulados · sin acciones reales"),
  ).toHaveCount(0);
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill("synthetic-only-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Inicio", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (
      await Promise.all(
        keys.map(async (k) =>
          (await (await caches.open(k)).keys()).map(
            (r) => new URL(r.url).pathname,
          ),
        ),
      )
    ).flat();
  });
  expect(cached).toContain("/index.html");
  expect(cached.some((url) => url.startsWith("/api/"))).toBe(false);
  await page.goto(`/equipo/${encodeURIComponent(resources[0]!.id)}`);
  await page.getByRole("button", { name: "Apagar", exact: true }).click();
  await holdConfirm(page);
  await expect(
    page.getByText("AWS no confirmó la recepción de la orden.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Sin confirmar", { exact: true }).first(),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page.goto("/ajustes");
  await page
    .getByRole("button", { name: "Cerrar sesión en este dispositivo" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Entrar", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill("synthetic-only-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Inicio", exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText("Sin conexión", { exact: true })).toBeVisible();
  await expect(page.getByText("prod-cms", { exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});

test('controles PC visibles y cambio de SO requiere confirmación e intención única', async ({ page }) => {
 const orders: {body: unknown; key: string | undefined}[]=[];
 await page.route('**/api/**', async route => {
  const req=route.request(); const path=new URL(req.url()).pathname;
  let data:unknown={};
  if(path==='/api/auth/me') data={name:'Admin',scopes:['read','operate']};
  if(path==='/api/resources') data={resources:[{id:'computer:desktop',name:'PC de casa',kind:'computer',state:'running',system:'cachyos',account:'Casa',location:'Windows / CachyOS',detail:'Dual boot',actions:['stop','boot-windows','refresh'],observedAt:new Date().toISOString()}],fetchedAt:new Date().toISOString(),refreshSeconds:60};
  if(path==='/api/operations'&&req.method()==='GET') data={operations:[]};
  if(path==='/api/operations'&&req.method()==='POST') {
   orders.push({body:req.postDataJSON(),key:req.headers()['idempotency-key']});
   data={id:'dualboot-test',resourceId:'computer:desktop',resourceName:'PC de casa',action:'boot-windows',actor:'Admin',state:'accepted',message:'Orden registrada',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  }
  if(path==='/api/operations/dualboot-test') data={id:'dualboot-test',resourceId:'computer:desktop',resourceName:'PC de casa',action:'boot-windows',actor:'Admin',state:'running',message:'Comprobando Windows',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await route.fulfill({status:path==='/api/operations'&&req.method()==='POST'?202:200,json:data});
 });
 await page.goto('http://127.0.0.1:4176/');
 await expect(page.getByRole('button',{name:/^Encender/})).toHaveCount(0);
 const power=page.getByRole('button',{name:'Apagar',exact:true});
 expect((await power.boundingBox())!.y).toBeLessThan(500);
 await expect(page.getByText('CachyOS',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Apagar',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Sistema: CachyOS ▾',exact:true}).click();
 await page.getByRole('button',{name:'Windows',exact:true}).click();
 expect(orders).toHaveLength(0);
 await expect(page.getByRole('alertdialog')).toContainText('Guarda tu trabajo');
 await page.getByRole('button',{name:'Reiniciar en Windows',exact:true}).click();
 await expect.poll(()=>orders.length).toBe(1);
 expect(orders[0]?.body).toEqual({resourceId:'computer:desktop',action:'boot-windows',confirmed:true});
 expect(orders[0]?.key).toMatch(/^[a-zA-Z0-9_-]+$/);
});

test('PC sin señal: encender y elegir SO están arriba a320px, sin botón Apagar',async({page})=>{
 await page.setViewportSize({width:320,height:720});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const data=path==='/api/resources'?{resources:[{id:'computer:desktop',name:'PC de casa',kind:'computer',state:'unreachable',system:'cachyos',actions:['start','boot-windows','boot-cachyos','refresh'],observedAt:new Date().toISOString(),account:'Casa',location:'Windows / CachyOS',detail:'Dual boot'}],fetchedAt:new Date().toISOString(),refreshSeconds:60}:path==='/api/operations'?{operations:[]}:{name:'Admin',scopes:['read','operate']};
  await route.fulfill({json:data});
 });
 await page.goto('/');
 const button=page.getByRole('button',{name:/^Encender/});
 await expect(button).toBeEnabled();
 expect((await button.boundingBox())!.y).toBeLessThan(450);
 await expect(page.getByRole('button',{name:'Apagar',exact:true})).toHaveCount(0);
 await button.click();
 await expect(page.getByRole('alertdialog')).toContainText('Elige el sistema');
 await page.getByRole('button',{name:'Windows',exact:true}).click();
 await expect(page.getByRole('button',{name:'Encender en Windows',exact:true})).toBeEnabled();
});

test('arranque predeterminado: se ve el sistema verificado y cambiarlo pide confirmar y no crea una orden de energía', async ({ page }) => {
 const now=new Date().toISOString();
 let boot={desired:'cachyos',effective:'cachyos',state:'applied',version:4,observedAt:now,verifiedAt:now};
 const writes:{body:unknown;key:string|undefined}[]=[];
 let operationPosts=0;
 await page.route('**/api/**',async route=>{
  const req=route.request(); const path=new URL(req.url()).pathname;
  let data:unknown={};
  if(path==='/api/auth/me') data={name:'Admin',scopes:['read','operate']};
  if(path==='/api/resources') data={cursor:1,fetchedAt:now,resources:[{id:'computer:desktop',name:'PC de casa',kind:'computer',state:'running',system:'windows',account:'Casa',location:'Windows / CachyOS',detail:'Dual boot',actions:['stop','boot-cachyos','refresh'],observedAt:now}]};
  if(path==='/api/operations'&&req.method()==='GET') data={operations:[]};
  if(path==='/api/operations'&&req.method()==='POST') operationPosts+=1;
  if(path==='/api/desktop/boot-preference'&&req.method()==='GET') data=boot;
  if(path==='/api/desktop/boot-preference'&&req.method()==='POST'){
   const body=req.postDataJSON() as {system:'windows'|'cachyos'};
   writes.push({body,key:req.headers()['idempotency-key']});
   boot={...boot,desired:body.system,effective:body.system,version:boot.version+1};
   data=boot;
  }
  await route.fulfill({json:data});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/^Sistema/}).click();
 await expect(page.getByRole('button',{name:'CachyOS, predeterminado'})).toBeVisible();
 await expect(page.getByText('★ Predeterminado: CachyOS.')).toBeVisible();
 await page.getByRole('button',{name:/^Windows/}).click();
 await page.getByRole('button',{name:'Hacer predeterminado',exact:true}).click();
 expect(writes).toHaveLength(0);
 await expect(page.getByRole('alertdialog')).toContainText('No se reinicia ahora');
 await page.getByRole('button',{name:'Sí, cambiar',exact:true}).click();
 await expect.poll(()=>writes.length).toBe(1);
 expect(writes[0]?.body).toEqual({system:'windows',confirmed:true,expectedVersion:4});
 expect(writes[0]?.key).toMatch(/^[a-zA-Z0-9_-]+$/);
 await expect(page.getByText('Listo: Windows es ahora el predeterminado.')).toBeVisible();
 expect(operationPosts).toBe(0);
});

test('apagar: elegir el sistema del próximo encendido fija el predeterminado antes de apagar; sin elegir no toca el arranque', async ({ page }) => {
 const now=new Date().toISOString();
 let boot={desired:'cachyos',effective:'cachyos',state:'applied',version:7,observedAt:now,verifiedAt:now};
 const calls:string[]=[];
 await page.route('**/api/**',async route=>{
  const req=route.request(); const path=new URL(req.url()).pathname;
  let data:unknown={};
  if(path==='/api/auth/me') data={name:'Admin',scopes:['read','operate']};
  if(path==='/api/resources') data={cursor:1,fetchedAt:now,resources:[{id:'computer:desktop',name:'PC de casa',kind:'computer',state:'running',system:'cachyos',account:'Casa',location:'Windows / CachyOS',detail:'Dual boot',actions:['stop','boot-windows','refresh'],observedAt:now}]};
  if(path==='/api/operations'&&req.method()==='GET') data={operations:[]};
  if(path==='/api/desktop/boot-preference'&&req.method()==='GET') data=boot;
  if(path==='/api/desktop/boot-preference'&&req.method()==='POST'){
   const body=req.postDataJSON() as {system:'windows'|'cachyos'};
   calls.push('preferencia:'+body.system+':v'+(req.postDataJSON() as {expectedVersion:number}).expectedVersion);
   boot={...boot,desired:body.system,effective:body.system,version:boot.version+1};
   data=boot;
  }
  if(path==='/api/operations'&&req.method()==='POST'){
   calls.push('orden:'+(req.postDataJSON() as {action:string}).action);
   data={id:'stop-test',resourceId:'computer:desktop',resourceName:'PC de casa',action:'stop',actor:'Admin',state:'accepted',message:'Orden registrada',createdAt:now,updatedAt:now};
  }
  if(path==='/api/operations/stop-test') data={id:'stop-test',resourceId:'computer:desktop',resourceName:'PC de casa',action:'stop',actor:'Admin',state:'running',message:'Apagando',createdAt:now,updatedAt:now};
  await route.fulfill({status:path==='/api/operations'&&req.method()==='POST'?202:200,json:data});
 });
 await page.goto('/');
 await page.getByRole('button',{name:'Apagar',exact:true}).click();
 const choice=page.getByRole('group',{name:'Sistema del próximo encendido'});
 await expect(choice).toContainText('CachyOS sigue como predeterminado.');
 await choice.getByRole('button',{name:'Windows',exact:true}).click();
 await expect(choice).toContainText('Se cambiará el predeterminado a Windows antes de apagar.');
 await holdConfirm(page);
 await expect.poll(()=>calls.length).toBe(2);
 expect(calls).toEqual(['preferencia:windows:v7','orden:stop']);
});

test('reiniciar en el mismo sistema: el sistema actual se puede elegir y envía la orden de ese sistema', async ({ page }) => {
 const now=new Date().toISOString();
 const orders:{body:unknown;key:string|undefined}[]=[];
 await page.route('**/api/**',async route=>{
  const req=route.request(); const path=new URL(req.url()).pathname;
  let data:unknown={};
  if(path==='/api/auth/me') data={name:'Admin',scopes:['read','operate']};
  if(path==='/api/resources') data={cursor:1,fetchedAt:now,resources:[{id:'computer:desktop',name:'PC de casa',kind:'computer',state:'running',system:'windows',account:'Casa',location:'Windows / CachyOS',detail:'Dual boot',actions:['stop','boot-windows','boot-cachyos','refresh'],observedAt:now}]};
  if(path==='/api/operations'&&req.method()==='GET') data={operations:[]};
  if(path==='/api/operations'&&req.method()==='POST'){
   orders.push({body:req.postDataJSON(),key:req.headers()['idempotency-key']});
   data={id:'restart-test',resourceId:'computer:desktop',resourceName:'PC de casa',action:'boot-windows',actor:'Admin',state:'accepted',message:'Orden registrada',createdAt:now,updatedAt:now};
  }
  if(path==='/api/operations/restart-test') data={id:'restart-test',resourceId:'computer:desktop',resourceName:'PC de casa',action:'boot-windows',actor:'Admin',state:'running',message:'Reiniciando',createdAt:now,updatedAt:now};
  await route.fulfill({status:path==='/api/operations'&&req.method()==='POST'?202:200,json:data});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/^Sistema/}).click();
 const dialog=page.getByRole('alertdialog');
 await expect(dialog).toContainText('Reinicia la PC en el mismo sistema');
 const restart=dialog.getByRole('button',{name:'Reiniciar en Windows',exact:true});
 await expect(restart).toBeEnabled();
 expect(orders).toHaveLength(0);
 await restart.click();
 await expect.poll(()=>orders.length).toBe(1);
 expect(orders[0]?.body).toEqual({resourceId:'computer:desktop',action:'boot-windows',confirmed:true});
 expect(orders[0]?.key).toMatch(/^[a-zA-Z0-9_-]+$/);
});

