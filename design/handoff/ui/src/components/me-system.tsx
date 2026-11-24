import type { ReactNode } from "react";
import type { SystemHealthResponse } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { provider } from "../app/providers.ts";
import { useRead } from "../hooks/useRead.ts";
import { age, dateTime } from "../lib/controlModel.ts";
import { healthExtras, inventorySources, panelState } from "../lib/meModel.ts";
import { describeResourceState, displayName } from "../lib/status.ts";
import { dotTone, type DotTone } from "./ui.tsx";
import { Card, Empty, Row, Rows, type V2Tone } from "./v2.tsx";
import { ReadGate } from "./ag-ui.tsx";

const DOT: Readonly<Record<DotTone, V2Tone>> = { ok: "ok", bad: "bad", unc: "unc", stale: "stale", busy: "busy", off: "off", unk: "unc", none: "neutral", key: "key" };
const Dot = ({ tone }: { tone: V2Tone }) => <span className={`v2-dot v2-dot--${tone}`} aria-hidden="true" />;

/** Tú › Estado del sistema: fuentes, avisos de equipos, panel y órdenes. Solo lo que da la API. */
export function SystemTab() {
  const app = useAppState(); const { expire } = useSession();
  const read = useRead(provider.getSystemHealth, true, null, expire, true);
  const health = read.data;
  const resources = app.inventory.data?.resources ?? [];
  const sources = inventorySources(resources, app.now);
  const devices = resources.filter(r => r.kind === "computer" || r.kind === "router");
  const catalog = health?.catalog;
  return <div className="v2-grid v2-grid--2">
    <div className="v2-stack">
      <Card title="Fuentes del inventario" meta={catalog && catalog.scopes > 0 ? `${catalog.healthyScopes} de ${catalog.scopes} leen bien` : undefined} flush id="me-sources">
        <ReadGate read={app.inventory} label="el inventario" rows={3}>
          {sources.length > 0 ? <>
            <div className="me-src me-src--head" aria-hidden="true"><span /><span>Fuente</span><span>Frecuencia</span><span>Última</span></div>
            <ul className="v2-rows" aria-label="Fuentes del inventario">{sources.map(s => <li key={s.key} className="me-src">
              <Dot tone={s.tone} />
              <span className="me-src__text"><span className="me-src__title">{s.title}</span><span className="me-src__sub">{s.sub}<span className="me-src__every"> · {s.every}</span>{s.tone !== "ok" && <> · <b className={`me-tone--${s.tone}`}>{s.status}</b></>}</span></span>
              <span className="me-src__col">{s.every}</span>
              <span className="t-age me-src__age">{s.lastAt ? age(s.lastAt, app.now) : "—"}</span>
            </li>)}</ul>
          </> : <Empty title="El inventario visible no incluye fuentes en la nube." />}
        </ReadGate>
      </Card>
      <Card title="Avisos de los equipos" flush id="me-devices">
        <ReadGate read={app.inventory} label="los equipos">
          {devices.length > 0 ? <Rows label="Avisos de los equipos">{devices.map(resource => { const view = describeResourceState(resource, app.now); return <li key={resource.id}><Row to={{ name: "resource", id: resource.id }} lead={<Dot tone={DOT[dotTone(view.tone, view.glyph)]} />} title={displayName(resource)} sub={view.hint ? `${view.label} · ${view.hint.toLocaleLowerCase("es")}` : view.label} age={age(resource.observedAt, app.now)} /></li>; })}</Rows> : <Empty title="No hay equipos que avisen en el inventario visible." />}
        </ReadGate>
      </Card>
    </div>
    <div className="v2-stack">
      <Card title="Panel" flush id="me-panel">
        <ReadGate read={read} label="el estado del panel" rows={3}>{health && <PanelRows health={health} />}</ReadGate>
      </Card>
      {health?.operations && <Card title="Órdenes" flush id="me-ops"><Rows label="Órdenes">
        <Count label="En curso" value={health.operations.active} tone="busy" />
        <Count label="Sin confirmar" value={health.operations.uncertain} tone="unc" />
        <Count label="Fallidas" value={health.operations.failed} tone="bad" />
      </Rows></Card>}
    </div>
  </div>;
}

function Count({ label, value, tone }: { label: string; value: number; tone: V2Tone }) {
  return <li><Row to={{ name: "activity" }} lead={<Dot tone={value > 0 ? tone : "neutral"} />} title={label} trailing={<span className={`me-num${value > 0 ? ` me-tone--${tone}` : ""}`}>{value}</span>} /></li>;
}

function PanelRows({ health }: { health: SystemHealthResponse }) {
  const app = useAppState();
  const extras = healthExtras(health);
  const panel = panelState(health.panel.state);
  const rows: { key: string; tone: V2Tone; title: string; sub: ReactNode; at?: string | null }[] = [
    { key: "panel", tone: panel.tone, title: "Servidor", sub: panel.label, at: health.panel.observedAt },
  ];
  if (health.panel.eventStreams !== undefined) { const n = health.panel.eventStreams; rows.push({ key: "live", tone: n > 0 ? "ok" : "neutral", title: "Cambios en vivo", sub: n === 1 ? "1 conexión abierta" : `${n} conexiones abiertas` }); }
  if (extras.push) { const p = extras.push; rows.push({ key: "push", tone: !p.enabled ? "off" : p.dead > 0 ? "stale" : "ok", title: "Avisos push", sub: !p.enabled ? "Sin configurar" : `${p.pending} pendientes · ${p.subscriptions} ${p.subscriptions === 1 ? "dispositivo" : "dispositivos"}${p.dead ? ` · ${p.dead} sin entregar` : ""}` }); }
  if (extras.costCache) { const c = extras.costCache; const cached = c.configuredAccounts - c.uncachedAccounts; rows.push({ key: "costs", tone: c.uncachedAccounts > 0 ? "stale" : "ok", title: "Caché de costes", sub: `${cached} de ${c.configuredAccounts} cuentas${c.earliestExpiry ? ` · vence ${dateTime(c.earliestExpiry, app.now)}` : ""}` }); }
  else if (app.costs.data) rows.push({ key: "costs", tone: "ok", title: "Caché de costes", sub: `Próxima lectura ${dateTime(app.costs.data.nextRefreshAt, app.now)}`, at: app.costs.data.fetchedAt });
  if (health.cloud) { const c = health.cloud; const s = panelState(c.state); rows.push({ key: "cloud", tone: !c.enabled ? "off" : c.consecutiveFailures > 0 ? "stale" : s.tone, title: "Observador AWS", sub: !c.enabled ? "Desactivado" : `${s.label}${c.consecutiveFailures ? ` · ${c.consecutiveFailures} fallos seguidos` : ""}`, at: c.lastCompletedAt }); }
  return <Rows label="Estado del panel">{rows.map(r => <li key={r.key}><Row lead={<Dot tone={r.tone} />} title={r.title} sub={r.sub} age={r.at !== undefined ? age(r.at, app.now) : undefined} /></li>)}</Rows>;
}
