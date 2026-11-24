import { useRef, useState } from "react";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { provider } from "../app/providers.ts";
import { ProviderError } from "../../../integration/provider.ts";
import type { ResourceExpectation } from "../contract.ts";
import { useRead } from "../hooks/useRead.ts";
import { dateTime, operationView } from "../lib/controlModel.ts";
import { Card, Pill, Row, Rows } from "./v2.tsx";
import { opTone } from "./inv-rows.tsx";

type Mode = ResourceExpectation["mode"];
const OPTIONS: readonly { mode: Mode; title: string; sub: string }[] = [
  { mode: "observe", title: "Solo observar", sub: "No avisa si se apaga." },
  { mode: "on-demand", title: "Bajo demanda", sub: "Apagarse es normal." },
  { mode: "always-on", title: "Siempre encendido", sub: "Avisa si deja de estar disponible." },
];
const ACTION_VERB = { start: "Encender", stop: "Apagar", refresh: "Consultar", "boot-windows": "Iniciar Windows", "boot-cachyos": "Iniciar CachyOS" } as const;

/**
 * Disponibilidad esperada: no envía energía. La API valida versión y sesión personal (no pide `confirmed`);
 * elegir y pulsar «Guardar» es la decisión explícita. Un fallo ambiguo vuelve a leer y no se reenvía.
 */
export function ResourcePolicy({ resourceId }: { resourceId: string }) {
  const app = useAppState(); const { user, expire } = useSession();
  const read = useRead(() => provider.getResourceExpectation(resourceId), true, 60000, expire, true, { identity: resourceId });
  const [chosen, setChosen] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState(0); const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const current = read.data?.expectation.mode ?? null;
  const mode = chosen ?? current;
  const reason = !user || user.agent || user.name !== "Admin" ? "Solo Admin puede cambiarla desde su sesión." : !app.online ? "Sin conexión." : !app.visible ? "Vuelve a la app para cambiarla." : read.error ? "No se pudo leer la política." : app.now < Math.max(retryAt, read.retryAt) ? "El servidor pidió esperar." : null;
  const blocked = reason !== null || busy || read.loading || !read.data;
  const dirty = chosen !== null && chosen !== current;
  const save = async () => {
    if (blocked || lock.current || !read.data || !dirty || !chosen) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await provider.putResourceExpectation(resourceId, read.data.expectation.version, chosen);
      read.setData(() => result); setChosen(null); app.inventory.refresh(); app.attention?.refresh();
    } catch (failure) {
      if (failure instanceof ProviderError && failure.status === 401) expire();
      if (failure instanceof ProviderError && failure.retryAfterSeconds) setRetryAt(Date.now() + failure.retryAfterSeconds * 1000);
      setError(failure instanceof ProviderError && failure.ambiguous ? "No se confirmó el cambio. Lo vuelvo a leer; no se reenvía." : "No se guardó: la política cambió o falló. Revisa la lectura y decide otra vez.");
      setChosen(null); read.refresh();
    } finally { lock.current = false; setBusy(false); }
  };
  const intent = read.data?.intent;
  return <Card title="Disponibilidad esperada" id="inv-policy" action={read.data?.expectation.updatedAt ? <span className="v2-card__meta">{dateTime(read.data.expectation.updatedAt, app.now)}</span> : undefined}>
    {!read.data ? <p className="inv-reason">{read.error ? "No se pudo leer la política." : "Leyendo…"}</p> : <>
      <div className="inv-options" role="radiogroup" aria-label="Disponibilidad esperada">
        {OPTIONS.map(option => <button key={option.mode} type="button" role="radio" aria-checked={mode === option.mode} className="inv-option" disabled={blocked} onClick={() => { setError(null); setChosen(option.mode === current ? null : option.mode); }}>
          <span className="inv-option__mark" aria-hidden="true" /><span className="inv-option__text"><span className="inv-option__title">{option.title}{option.mode === current && <span className="inv-tag">actual</span>}</span><span className="inv-option__sub">{option.sub}</span></span>
        </button>)}
      </div>
      {dirty && <div className="inv-actions__row inv-policy__save"><button type="button" className="btn btn--primary inv-btn" disabled={blocked} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar"}</button><button type="button" className="btn inv-btn" disabled={busy} onClick={() => setChosen(null)}>Cancelar</button></div>}
      {reason && <p className="inv-reason">{reason}</p>}
      {error && <p className="inv-error" role="alert">{error}</p>}
    </>}
    {intent && <div className="inv-policy__intent"><Rows label="Última orden de energía"><li><Row to={{ name: "operation", id: intent.operationId }} title={`Última orden: ${ACTION_VERB[intent.action]}${intent.targetSystem ? ` · ${intent.targetSystem === "windows" ? "Windows" : "CachyOS"}` : ""}`} sub={dateTime(intent.requestedAt, app.now)} trailing={<Pill tone={opTone(operationView(intent.result).tone)}>{operationView(intent.result).label}</Pill>} /></li></Rows></div>}
  </Card>;
}
