import { useState } from "react";
import { useAppState } from "../app/AppState.tsx";
import { useIsWide } from "../hooks/usePlatform.ts";
import { navigate } from "../lib/router.tsx";
import type { Resource } from "../contract.ts";
import { hermesMood } from "../lib/mood.ts";
import {
  isActiveOperation,
  isHermes,
  needsAttention,
  needsReview,
  describeOperation,
  operationTitle,
} from "../lib/status.ts";
import { formatAgo } from "../lib/format.ts";
import { Panel } from "../components/Panel.tsx";
import { IconKey, Key } from "../components/Key.tsx";
import { Hermes } from "../components/Hermes.tsx";
import { Pill, StatePill } from "../components/Pill.tsx";
import { macCardView } from "../lib/macCard.ts";
import { ResourceRow } from "../components/ResourceRow.tsx";
import { ResourceDetail } from "../components/ResourceDetail.tsx";
import { DesktopControls } from "../components/DesktopControls.tsx";
import { Disclosure } from "../components/Fields.tsx";
import { SkyBackground } from "../components/SkyBackground.tsx";
import {
  FiberhomeSprite,
  MacSprite,
  type FiberhomeMode,
} from "../components/HomeSprites.tsx";

function greeting(now: number): string {
  const hour = Number(
    new Intl.DateTimeFormat("es", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/Bogota",
    }).format(now),
  );
  return hour < 6 ? "Buenas noches" : hour < 13 ? "Buenos días" : hour < 20 ? "Buenas tardes" : "Buenas noches";
}

function routerMode(resource: Resource, reading: boolean): FiberhomeMode {
  if (resource.state === "stale") return "stale";
  if (resource.state === "unknown") return "unknown";
  return reading ? "reading" : "reporting";
}

function MacCard({ mac, now }: { mac: Resource; now: number }) {
  const view = macCardView(mac, now);
  return (
    <Panel tone="paper" className={`home-card ${view.linked ? "" : "home-card--dashed"}`}>
      <div className="home-card__head">
        <span className={`sprite-tile ${view.linked ? "" : "sprite-tile--dashed"}`}>
          <MacSprite mode={view.mode} width={view.linked ? 80 : 64} />
        </span>
        <div className="grow">
          <h3 className="t-h3">MacBook</h3>
          {view.pill && (
            <Pill tone={view.pill.tone} glyph={view.pill.glyph}>
              {view.pill.label}
            </Pill>
          )}
          <p className="t-caption mt-8">{view.caption}</p>
        </div>
      </div>
    </Panel>
  );
}

export function Control() {
  const app = useAppState(),
    wide = useIsWide();
  const [selected, select] = useState<string | null>(null);
  const resources = app.inventory.data?.resources ?? [],
    operations = app.operations.data?.operations ?? [],
    pc = resources.find((r) => r.id === "computer:desktop"),
    hermes = resources.find(isHermes),
    router = resources.find((r) => r.kind === "router"),
    mac = resources.find((r) => r.id === "computer:mac");
  const open = (resource: Resource) =>
    wide && resource.id !== "computer:desktop"
      ? select(resource.id)
      : navigate({ name: "resource", id: resource.id });
  const chosen = resources.find((r) => r.id === selected);
  const cloud = resources.filter(
    (r) => (r.kind === "ec2" && !isHermes(r)) || r.kind === "service",
  );
  // Una orden sin confirmar se da por resuelta cuando llega una observación posterior del equipo,
  // cuando una orden más reciente sobre él terminó bien, o pasadas 24 h.
  const pending = operations.filter((o) => {
    if (!needsReview(o)) return false;
    const target = resources.find((r) => r.id === o.resourceId);
    const orderAt = Date.parse(o.updatedAt);
    if (target?.observedAt && Date.parse(target.observedAt) > orderAt) return false;
    if (app.now - orderAt > 24 * 3600 * 1000) return false;
    return !operations.some(
      (n) => n.resourceId === o.resourceId && n.state === "succeeded" && Date.parse(n.updatedAt) > orderAt,
    );
  });
  const reviewed = pending.filter((o, i) => pending.findIndex((n) => n.resourceId === o.resourceId) === i);
  const review = reviewed.length;
  const firstReview = reviewed[0];
  const services = resources.filter((r) => r.kind === "service");
  const serviceDown =
    services.length > 0 &&
    services.every((r) => r.state === "unknown" || r.observedAt === null);
  const attention = resources.filter(needsAttention).length;
  const headline = !app.inventory.data
    ? "Cargando…"
    : review > 0
      ? `${review} ${review === 1 ? "orden sin confirmar" : "órdenes sin confirmar"}`
      : attention > 0
        ? `${attention} ${attention === 1 ? "equipo necesita atención" : "equipos necesitan atención"}`
        : "Todo en orden";
  const fresh = app.inventory.data
    ? `${resources.length - attention} de ${resources.length} al día · ${formatAgo(app.inventory.data.fetchedAt, app.now)}`
    : "";
  const refresh = async (resource: Resource) => {
    try {
      const op = await app.submit({ resourceId: resource.id, action: "refresh" });
      navigate({ name: "operation", id: op.id });
    } catch {
      /* el aviso de error lo muestra el estado global */
    }
  };
  const busy = (resource: Resource) =>
    operations.some((o) => o.resourceId === resource.id && isActiveOperation(o));
  const lastHermes = operations.find((o) => o.actor === "hermes");
  const readingRouter = router ? busy(router) : false;
  const hermesOp = hermes
    ? operations.find((o) => o.resourceId === hermes.id)
    : undefined;
  return (
    <>
      <SkyBackground />
      <header className="control-header">
        <div>
          <p className="t-label">{greeting(app.now).toUpperCase()}, ADMIN</p>
          <h1 className="t-h2">{headline}</h1>
          {fresh && <p className="control-header__fresh">{fresh}</p>}
        </div>
        <div className="row-flex gap-10">
          <IconKey to={{ name: "settings" }} label="Ajustes" glyph="settings" />
        </div>
      </header>
      {firstReview && (
        <section className="aviso" aria-labelledby="aviso-t">
          <span className="aviso__mark" aria-hidden="true">?</span>
          <div className="grow">
            <h2 id="aviso-t" className="aviso__title">
              No sabemos si se aplicó la orden en {firstReview.resourceName}
            </h2>
            <p className="t-small">
              {firstReview.message} · {formatAgo(firstReview.updatedAt, app.now)}
            </p>
            <Key variant="sun" size="sm" onClick={() => navigate({ name: "operation", id: firstReview.id })}>
              Comprobar estado
            </Key>
          </div>
        </section>
      )}
      {serviceDown && (
        <section className="aviso" aria-labelledby="aviso-g">
          <span className="aviso__mark" aria-hidden="true">◷</span>
          <div className="grow">
            <h2 id="aviso-g" className="aviso__title">Coolify no responde</h2>
            <p className="t-small">
              Los {services.length} servicios están sin datos. No implica que estén caídos; se vuelve a intentar solo.
            </p>
          </div>
        </section>
      )}
      <div className={`cols control-content ${chosen ? "" : "cols--single"}`}>
        <div className="control-list">
          <h2 className="t-label secondary-heading sky-label">CASA</h2>
          {pc ? (
            <DesktopControls resource={pc} />
          ) : (
            <Panel tone="paper">
              <p role="status">
                {app.inventory.loading ? "Cargando tu PC…" : "No se pudo leer la PC."}
              </p>
            </Panel>
          )}
          {router && (
            <>
              <div className="home-link" aria-hidden="true">
                <span className="home-link__rail">
                  <span className="home-link__pulse link-pulse" />
                </span>
                <span>ENCENDIDO Y CAMBIO DE SISTEMA VÍA</span>
              </div>
              <Panel tone="paper" accent="coral" className="home-card">
                <div className="home-card__head">
                  <span className="sprite-tile">
                    <FiberhomeSprite
                      mode={routerMode(router, readingRouter)}
                      width={96}
                    />
                  </span>
                  <div className="grow">
                    <h3 className="t-h3">FiberHome</h3>
                    <p className="t-caption">Internet de casa</p>
                    <StatePill resource={router} />
                  </div>
                </div>
                <div className="mt-12">
                  <Key
                    variant="sun"
                    block
                    disabled={!app.canWrite || readingRouter || !router.actions.includes("refresh")}
                    onClick={() => void refresh(router)}
                  >
                    {readingRouter ? "Leyendo…" : "Leer ahora"}
                  </Key>
                </div>
              </Panel>
            </>
          )}
          {hermes && (
            <>
              <h2 className="t-label secondary-heading sky-label">ORQUESTADOR</h2>
              <Panel tone="paper" accent="violet" className="home-card">
                <div className="home-card__head">
                  <span className="sprite-tile sprite-tile--hermes">
                    <Hermes size={96} mood={hermesMood(hermes, hermesOp)} />
                  </span>
                  <div className="grow">
                    <h3 className="t-h2">Hermes</h3>
                    <p className="t-caption">EC2 orchestrator</p>
                    <StatePill resource={hermes} />
                  </div>
                </div>
                {lastHermes && (
                  <p className="home-last">
                    Última orden de Hermes: <strong>{operationTitle(lastHermes, resources.find((r) => r.id === lastHermes.resourceId)?.kind ?? null)}</strong>{" "}
                    {formatAgo(lastHermes.updatedAt, app.now)} · {describeOperation(lastHermes.state).label.toLowerCase()}
                  </p>
                )}
                <div className="key-pair mt-12">
                  <Key
                    variant="sun"
                    disabled={!app.canWrite || busy(hermes) || !hermes.actions.includes("refresh")}
                    onClick={() => void refresh(hermes)}
                  >
                    Consultar
                  </Key>
                  <Key variant="night" onClick={() => open(hermes)}>
                    Energía ▸
                  </Key>
                </div>
              </Panel>
            </>
          )}
          {mac && (
            <>
              <h2 className="t-label secondary-heading sky-label">PERSONAL</h2>
              <MacCard mac={mac} now={app.now} />
            </>
          )}
          <h2 className="t-label secondary-heading sky-label">NUBE</h2>
          <Panel tone="paper" flush>
            <Disclosure
              summary={`Nube · ${cloud.filter((r) => r.kind === "ec2").length} EC2 y ${cloud.filter((r) => r.kind === "service").length} servicios`}
            >
              {cloud.map((r) => (
                <ResourceRow key={r.id} resource={r} now={app.now} onSelect={open} />
              ))}
            </Disclosure>
          </Panel>
        </div>
        {chosen && (
          <aside className="cols__aside" aria-label="Detalle seleccionado">
            <ResourceDetail key={chosen.id} resource={chosen} compact />
          </aside>
        )}
      </div>
    </>
  );
}
