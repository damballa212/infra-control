import { useEffect, useRef, useState } from "react";
import type { BootSystem } from "../contract.ts";
import { SYSTEM_NAME } from "../lib/bootDefault.ts";
import { ConfirmPowerDialog } from "./Dialog.tsx";
import { Key } from "./Key.tsx";
import { useBootDefault } from "./BootDefault.tsx";
export function StopDialog({ busy, onStop, onCancel }: { busy: boolean; onStop: () => void; onCancel: () => void }) {
  const boot = useBootDefault(); const [next, setNext] = useState<BootSystem | null>(null); const [continuing, setContinuing] = useState(false);
  const active = useRef(false); const generation = useRef(0); const lock = useRef(false);
  const latest = useRef({ busy, onStop, onCancel, boot, next }); latest.current = { busy, onStop, onCancel, boot, next };
  useEffect(() => { active.current = true; generation.current += 1; return () => { active.current = false; generation.current += 1; }; }, []);
  useEffect(() => { generation.current += 1; setNext(null); setContinuing(false); }, [boot.confirmationRevision]);
  const cancel = () => { active.current = false; generation.current += 1; latest.current.onCancel(); };
  const confirm = async () => {
    const context = latest.current;
    if (!active.current || lock.current || context.busy || context.boot.blocker || context.boot.recoveryRequired) return;
    const ticket = generation.current; const target = context.next; lock.current = true; setContinuing(true);
    try {
      if (target && !(context.boot.preference?.state === "applied" && context.boot.preference.effective === target)) { const applied = await context.boot.set(target); if (!applied) return; }
      if (!active.current || ticket !== generation.current || latest.current.busy || latest.current.boot.recoveryRequired || latest.current.next !== target) return;
      latest.current.onStop();
    } finally { lock.current = false; if (active.current && ticket === generation.current) setContinuing(false); }
  };
  const preference = boot.preference; const effective = preference?.effective ?? null; const settled = preference?.state === "applied" && effective !== null; const selected = next ?? effective;
  const changing = next !== null && !(preference?.state === "applied" && preference.effective === next);
  const extra = <>{(settled || next !== null) && selected && <div className="boot-choice" role="group" aria-label="Sistema del próximo encendido"><p className="t-small boot-choice__label">Al volver a encender arrancará con:</p><div className="system-options">{(["cachyos", "windows"] as const).map(system => <Key key={system} variant={selected === system ? "sunOnNight" : "cream"} size="sm" aria-pressed={selected === system} disabled={busy || continuing || boot.blocker !== null || boot.recoveryRequired} onClick={() => { if (lock.current) return; boot.clearMessages(); setNext(system); }}>{SYSTEM_NAME[system]}</Key>)}</div><p className={boot.error ? "t-small boot-default__error" : "t-small boot-choice__note"} role={boot.error ? "alert" : "status"}>{boot.error ?? (changing ? `Se cambiará el predeterminado a ${SYSTEM_NAME[selected]} antes de apagar.` : `${SYSTEM_NAME[selected]} sigue como predeterminado.`)}</p></div>}{boot.blocker && <p className="t-small mt-12" role="status">{boot.blocker}</p>}{boot.recoveryRequired && <div className="stack gap-8 mt-12"><p className="t-small">La confirmación anterior quedó invalidada. Revisa la preferencia actual antes de decidir otra orden.</p><button type="button" className="btn" disabled={boot.blocker !== null || continuing} onClick={() => void boot.recover()}>Revisar preferencia actual</button></div>}{boot.notice && <p className="t-small mt-12" role="status">{boot.notice}</p>}</>;
  return <ConfirmPowerDialog title="¿Apagar la PC?" lines={["Guarda tu trabajo: se cerrarán las sesiones de la PC."]} confirmLabel="Sí, apagar" showSleepingHermes={false} busy={busy || continuing || boot.blocker !== null || boot.recoveryRequired} holdMs={1000} extra={extra} onCancel={cancel} onConfirm={() => void confirm()} />;
}
