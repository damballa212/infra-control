import { useState } from "react";
import type { Action, Resource } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { isActiveOperation } from "../lib/status.ts";
import { navigate } from "../lib/router.tsx";
import { Panel } from "./Panel.tsx";
import { Key } from "./Key.tsx";
import { PcSprite, type PcMode } from "./HomeSprites.tsx";
import { ConfirmPowerDialog, SystemPickerDialog } from "./Dialog.tsx";
import { StopDialog } from "./StopDialog.tsx";
export function DesktopControls({resource}:{resource:Resource}) {
 const app=useAppState(); const [confirm,setConfirm]=useState(false);const [picker,setPicker]=useState(false);
 const active=app.operations.data?.operations.find(o=>o.resourceId===resource.id&&isActiveOperation(o));
 const running=resource.state==='running'; const primary:Action=running?'stop':'start';
 const canPick=!running&&resource.actions.some(a=>a==='boot-windows'||a==='boot-cachyos');
 const allowed=(action:Action)=>app.canWrite&&!active&&resource.actions.includes(action);
 const submit=async(action:Action)=>{
  if(!allowed(action))return;
  try{const op=await app.submit({resourceId:resource.id,action,confirmed:true});setConfirm(false);setPicker(false);navigate({name:'operation',id:op.id});}
  catch{setConfirm(false);setPicker(false);}
 };
 const name=resource.system==='windows'?'Windows':resource.system==='cachyos'?'CachyOS':null;
 const label=active?'Orden en curso':resource.state==='stopping'?'Apagando…':resource.state==='pending'?'Reiniciando…':running?'En línea':resource.state==='stopped'?'Apagado anunciado':resource.state==='unconfigured'?'Por conectar':'Sin señal';
 const pcMode:PcMode=resource.state==='running'?(resource.system==='windows'?'windows':'cachyos'):resource.state==='stopped'?'off':resource.state==='pending'?'booting':resource.state==='stopping'?'stopping':'nosignal';
 return <Panel tone="paper" accent="coral" className="pc-command">
  <div className="pc-command__heading"><span className="sprite-tile"><PcSprite mode={pcMode} width={96}/></span><div className="grow"><h2 className="t-h3">PC de casa</h2><p className="pc-command__system">{running&&name?name:label}</p></div>{running&&<span className="pc-command__status is-online">● En línea</span>}</div>
  <div className="pc-command__actions">
   <Key variant={running?'red':'sun'} disabled={!allowed(primary)} onClick={()=>canPick?setPicker(true):setConfirm(true)}>{active?'Procesando…':resource.state==='pending'?'Reiniciando…':resource.state==='stopping'?'Apagando…':running?'Apagar':canPick?'Encender ▾':'Encender'}</Key>
   {!canPick&&<Key variant="sun" disabled={!app.canWrite||!!active||!resource.actions.some(a=>a==='boot-windows'||a==='boot-cachyos')} onClick={()=>setPicker(true)}>Sistema{name&&running?`: ${name}`:''} ▾</Key>}
  </div>
  {active&&<p role="status" className="t-small mt-12">{active.message}</p>}
  {!active&&!running&&resource.state!=='stopped'&&<p className="t-small mt-12">{resource.state==='unreachable'?'La PC dejó de avisar; puede estar apagada o sin conexión.':'Esperando el aviso de la PC.'}</p>}
  {confirm&&running&&<StopDialog busy={app.sending} onCancel={()=>setConfirm(false)} onStop={()=>void submit(primary)}/>}
  {confirm&&!running&&<ConfirmPowerDialog title="¿Encender la PC?" lines={['Arrancará con su sistema predeterminado. Para elegir otro, usa Sistema.']} confirmLabel="Sí, encender" showSleepingHermes={false} busy={app.sending} onCancel={()=>setConfirm(false)} onConfirm={()=>void submit(primary)}/>}
  {picker&&<SystemPickerDialog current={resource.system} running={running} actions={resource.actions} busy={app.sending} onCancel={()=>setPicker(false)} onChoose={system=>void submit(system==='windows'?'boot-windows':'boot-cachyos')}/>}
 </Panel>;
}
