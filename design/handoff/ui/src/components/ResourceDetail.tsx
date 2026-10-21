import { DesktopControls } from "./DesktopControls.tsx";
import { useState } from "react";
import type { Resource } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import {
  can,
  describeResourceState,
  displayName,
  isActiveOperation,
  isHermes,
  kindLabel,
  powerAction,
} from "../lib/status.ts";
import { formatAgo, formatClock } from "../lib/format.ts";
import { hermesMood } from "../lib/mood.ts";
import { navigate } from "../lib/router.tsx";
import { Panel } from "./Panel.tsx";
import { StatePill } from "./Pill.tsx";
import { Key } from "./Key.tsx";
import { Hermes } from "./Hermes.tsx";
import { CloudSprite } from "./Sprites.tsx";
import { FiberhomeSprite, MacSprite } from "./HomeSprites.tsx";
import { Disclosure } from "./Fields.tsx";
import { ConfirmPowerDialog } from "./Dialog.tsx";
export function ResourceDetail({
  resource,
  compact = false,
}: {
  resource: Resource;
  compact?: boolean;
}) {
  const app = useAppState();
  const [confirm, setConfirm] = useState(false);
  const active = app.operations.data?.operations.find(
    (o) => o.resourceId === resource.id && isActiveOperation(o),
  );
  const action = powerAction(resource);
  const available = app.canWrite && !active;
  const send = async (energy: boolean) => {
    try {
      const operation = await app.submit({
        resourceId: resource.id,
        action: energy && action ? action : "refresh",
        ...(energy ? { confirmed: true } : {}),
      });
      setConfirm(false);
      navigate({ name: "operation", id: operation.id });
    } catch {
      setConfirm(false);
    }
  };
  if (resource.id === "computer:desktop") return <div className="stack gap-22"><DesktopControls resource={resource}/><Disclosure summary="Información y diagnóstico"><p className="t-small">{resource.note}</p><p className="t-small">Último aviso: {resource.observedAt?formatClock(resource.observedAt):"Sin aviso"}</p><p className="t-small">{resource.detail}</p></Disclosure></div>;
  return (
    <div className="stack gap-22">
      <Panel tone="night" accent="coral">
        <div className="row-flex gap-14">
          <span className="detail-sprite">
            {isHermes(resource) ? (
              <Hermes
                mood={hermesMood(resource, active)}
                size={compact ? 80 : 96}
              />
            ) : resource.kind === "router" ? (
              <FiberhomeSprite
                mode={
                  active
                    ? "reading"
                    : resource.state === "reporting"
                      ? "reporting"
                      : resource.state === "stale"
                        ? "stale"
                        : "unknown"
                }
                width={96}
              />
            ) : resource.kind === "computer" ? (
              <MacSprite
                mode={resource.state === "running" ? "on" : resource.state === "unconfigured" ? "unlinked" : "nosignal"}
                width={80}
              />
            ) : (
              <CloudSprite width={80} mood={active ? "busy" : "idle"} />
            )}
          </span>
          <div className="grow">
            <p className="t-label">{kindLabel(resource)}</p>
            <h2 className="t-title t-wrap mt-8">{displayName(resource)}</h2>
            <p className="t-small t-mono t-wrap mt-8">{resource.detail}</p>
          </div>
        </div>
      </Panel>
      <Panel tone="paper">
        <p className="t-label">ESTADO</p>
        <div className="row-flex wrap gap-12 mt-10">
          <StatePill resource={resource} />
          <span className="t-small">
            {describeResourceState(resource).hint}
          </span>
        </div>
        <dl className="data-list mt-14">
          <dt>VISTO</dt>
          <dd>
            {resource.observedAt
              ? formatClock(resource.observedAt)
              : "Sin observación"}
          </dd>
          <dt>HACE</dt>
          <dd>{formatAgo(resource.observedAt, app.now)}</dd>
        </dl>
      </Panel>
      {resource.note && (
        <Panel tone="night" className="panel--note">
          <p className="t-small">{resource.note}</p>
        </Panel>
      )}
      {resource.kind === "router" && (
        <p className="t-small">
          Reportar no garantiza que Internet funcione completo. Leer encola una
          consulta segura; no reinicia el router.
        </p>
      )}
      {resource.kind === "computer" && resource.actions.length === 0 && (
        <Panel tone="paper">
          <h3 className="t-h3">Qué falta para controlarlo</h3>
          <p className="mt-12">
            Acceso remoto y capacidades verificadas. Linux offline no significa
            PC apagada.
          </p>
          <p className="mt-12">○ Por conectar</p>
        </Panel>
      )}
      <Panel tone="paper" flush>
        <Disclosure summary="Datos técnicos">
          <dl className="data-list">
            <dt>Cuenta</dt>
            <dd>{resource.account}</dd>
            <dt>Ubicación</dt>
            <dd>{resource.location}</dd>
            <dt>Tipo</dt>
            <dd>{resource.detail}</dd>
            <dt>Estado crudo</dt>
            <dd>{resource.state}</dd>
            <dt>ID panel</dt>
            <dd>{resource.id}</dd>
          </dl>
        </Disclosure>
      </Panel>
      {resource.id === "computer:desktop" && <DesktopControls resource={resource} />}
      <div className="key-pair mt-8">
        {can(resource, "refresh") && (
          <Key
            variant="night"
            disabled={!available}
            onClick={() => void send(false)}
          >
            {resource.kind === "router" ? "Leer ahora" : "Consultar estado"}
          </Key>
        )}
        {action && resource.id !== "computer:desktop" && (
          <Key
            variant={action === "stop" ? "danger" : "sun"}
            disabled={!available}
            onClick={() => setConfirm(true)}
          >
            {action === "stop" ? "Apagar" : "Encender"}
          </Key>
        )}
      </div>
      {active && (
        <p role="status" className="t-small">
          Hay una orden activa para este equipo. Las acciones vuelven al
          terminar.
        </p>
      )}
      {!app.online && (
        <p className="t-small">Sin conexión. No puedes enviar órdenes.</p>
      )}
      {resource.actions.length === 0 && (
        <p className="t-small">No hay acciones disponibles para este equipo.</p>
      )}
      {confirm && action && (
        <ConfirmPowerDialog
          title={`${action === "stop" ? "¿Apagar" : "¿Encender"} ${displayName(resource)}?`}
          lines={[
            ...(isHermes(resource) && action === "stop"
              ? [
                  "Se detendrá el orquestador Hermes. El panel seguirá disponible.",
                ]
              : [`Se enviará una orden a ${resource.name}.`]),
            "Aceptar la orden no confirma su resultado. Podrás seguirla en Actividad.",
          ]}
          confirmLabel={action === "stop" ? "Sí, apagar" : "Sí, encender"}
          showSleepingHermes={isHermes(resource) && action === "stop"}
          busy={app.sending}
          holdMs={action === "stop" ? (isHermes(resource) || /^prod-/.test(resource.name) ? 1500 : 1000) : undefined}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            if (available) void send(true);
          }}
        />
      )}
    </div>
  );
}
