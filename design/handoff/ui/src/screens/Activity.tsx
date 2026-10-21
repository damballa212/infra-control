import { useEffect, useState } from "react";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { useRead } from "../hooks/useRead.ts";
import { provider } from "../app/providers.ts";
import {
  actorLabel,
  describeOperation,
  isActiveOperation,
  needsReview,
  operationTitle,
} from "../lib/status.ts";
import { formatClock, formatDay } from "../lib/format.ts";
import { Link } from "../lib/router.tsx";
import { Panel } from "../components/Panel.tsx";
import { FilterChips, Disclosure } from "../components/Fields.tsx";
import { BackKey, Key, LinkKey } from "../components/Key.tsx";
import { OperationPill } from "../components/Pill.tsx";
import { OrderStages } from "../components/Stages.tsx";
import { Banner } from "../components/Banner.tsx";
import { Hermes } from "../components/Hermes.tsx";
export function Activity() {
  const app = useAppState();
  const [filter, setFilter] = useState<"all" | "people" | "agents" | "review">(
    "all",
  );
  useEffect(() => {
    app.operations.refresh();
  }, [app.operations.refresh]);
  const rows = (app.operations.data?.operations ?? []).filter(
    (o) =>
      filter === "all" ||
      (filter === "people" && o.actor === "admin") ||
      (filter === "agents" && o.actor !== "admin") ||
      (filter === "review" && ["uncertain", "failed"].includes(o.state)),
  );
  return (
    <div className="page stack gap-26">
      <header>
        <p className="t-label">PERSONAS Y AGENTES</p>
        <h1 className="t-h1 mt-8">Actividad</h1>
        <p className="t-small mt-12">
          {app.operations.data?.operations.some(isActiveOperation)
            ? "Se consulta cada 5 s mientras hay órdenes."
            : "Hasta 100 órdenes más recientes."}
        </p>
      </header>
      <FilterChips
        label="Filtrar actividad"
        options={[
          { value: "all", label: "Todas" },
          { value: "people", label: "Admin" },
          { value: "agents", label: "Agentes" },
          { value: "review", label: "Por revisar" },
        ]}
        value={filter}
        onChange={setFilter}
      />
      {app.operations.error ? (
        <Banner
          tone="bad"
          glyph="cross"
          title="No pudimos leer la actividad"
          action={
            <Key
              variant="cream"
              disabled={app.now < app.operations.retryAt}
              onClick={app.operations.refresh}
            >
              Volver a consultar
            </Key>
          }
        >
          Se conserva la última lectura.
        </Banner>
      ) : null}
      {rows.length ? (
        <Panel tone="paper" accent="violet" flush>
          {rows.map((o) => (
            <Link
              to={{ name: "operation", id: o.id }}
              key={o.id}
              className="list-row operation-row"
            >
              <span
                className={`order-band ${isActiveOperation(o) ? "is-active" : o.state === "uncertain" ? "is-unc" : o.state === "failed" ? "is-bad" : "is-ok"}`}
              />
              <span className="grow stack gap-8">
                <strong className="t-strong t-wrap">
                  {operationTitle(
                    o,
                    app.inventory.data?.resources.find(
                      (r) => r.id === o.resourceId,
                    )?.kind ?? null,
                  )}
                </strong>
                <span className="t-caption">
                  {actorLabel(o.actor).who} · {formatDay(o.createdAt)}{" "}
                  {formatClock(o.createdAt)}
                </span>
                <OperationPill state={o.state} />
              </span>
              <span aria-hidden="true">▸</span>
            </Link>
          ))}
        </Panel>
      ) : (
        <Panel tone="paper">
          <div className="empty">
            <Hermes mood="calm" size={80} />
            <h2 className="t-h3">
              {app.operations.loading
                ? "Leyendo actividad…"
                : "No hay órdenes aquí"}
            </h2>
            <p>
              Las órdenes de personas y agentes aparecerán con su resultado.
            </p>
          </div>
        </Panel>
      )}
    </div>
  );
}
export function OperationScreen({ id }: { id: string }) {
  const app = useAppState();
  const { expire } = useSession();
  const [poll, setPoll] = useState(true);
  const query = useRead(
    async () => {
      const value = await provider.getOperation(id);
      setPoll(isActiveOperation(value));
      return value;
    },
    true,
    poll ? 5000 : null,
    expire,
  );
  const op =
    query.data ?? app.operations.data?.operations.find((o) => o.id === id);
  const resource = app.inventory.data?.resources.find(
    (r) => r.id === op?.resourceId,
  );
  const [checkRequested, setCheckRequested] = useState(false);
  const checkedRead = useRead(
    provider.getResources,
    checkRequested,
    null,
    expire,
  );
  const checked = checkedRead.data !== null;
  const checking = checkedRead.loading;
  const checkError = !!checkedRead.error;
  useEffect(() => {
    if (query.data) app.attach(query.data);
  }, [query.data]);
  useEffect(() => {
    if (checkedRead.data) app.inventory.setData(() => checkedRead.data!);
  }, [checkedRead.data]);
  const check = () => {
    setCheckRequested(true);
    checkedRead.refresh();
    query.refresh();
  };

  return (
    <div className="page stack gap-26">
      <BackKey to={{ name: "activity" }}>Actividad</BackKey>
      {op ? (
        <>
          <header>
            <p className="t-label">{actorLabel(op.actor).long}</p>
            <h1 className="t-title t-wrap mt-12">
              {operationTitle(op, resource?.kind ?? null)}
            </h1>
          </header>
          <Panel tone="paper" accent="violet">
            <p className="t-label">ESTADO</p>
            <div className="mt-12">
              <OperationPill state={op.state} />
            </div>
            <div className="mt-22">
              <OrderStages state={op.state} />
            </div>
            <dl className="data-list mt-18">
              <dt>Registrada</dt>
              <dd>{formatClock(op.createdAt)}</dd>
              <dt>Última actualización</dt>
              <dd>{formatClock(op.updatedAt)}</dd>
            </dl>
            <p className="mt-14" role="status">
              {op.message}
            </p>
          </Panel>
          {needsReview(op) && (
            <Panel tone="sun" accent="orange">
              <h2 className="t-h3">Antes de repetir</h2>
              <p className="mt-14">
                1. Comprueba el estado real. El panel nunca reenvía una orden
                ambigua por su cuenta.
              </p>
              <Key
                className="mt-22"
                variant="night"
                block
                loading={checking}
                disabled={
                  !app.online || checking || app.now < checkedRead.retryAt
                }
                onClick={check}
              >
                Consultar estado de {op.resourceName}
              </Key>
              {checked && (
                <p role="status" className="mt-18">
                  Estado consultado. Esto no demuestra que la orden anterior se
                  ejecutara. Revisa la observación del equipo antes de decidir.
                </p>
              )}
              {checkError && (
                <p role="alert" className="mt-18">
                  No se pudo comprobar. Espera antes de volver a consultar.
                </p>
              )}
              <p className="mt-22">
                2. Si aún quieres el cambio, envía una orden nueva desde el
                equipo y confírmala otra vez.
              </p>
              {checked && resource && (
                <LinkKey
                  className="mt-22"
                  variant="paper"
                  to={{ name: "resource", id: resource.id }}
                >
                  Ver equipo y decidir ▸
                </LinkKey>
              )}
            </Panel>
          )}
          {resource && (
            <LinkKey variant="night" to={{ name: "resource", id: resource.id }}>
              Ver equipo ▸
            </LinkKey>
          )}
          <Panel tone="paper" flush>
            <Disclosure summary="Datos técnicos">
              <dl className="data-list">
                <dt>ID orden</dt>
                <dd>{op.id}</dd>
                <dt>Recurso</dt>
                <dd>{op.resourceId}</dd>
                <dt>Acción</dt>
                <dd>{op.action}</dd>
                <dt>Actor</dt>
                <dd>{op.actor}</dd>
              </dl>
            </Disclosure>
          </Panel>
          {describeOperation(op.state).final && op.state === "succeeded" && (
            <p className="t-small">
              Confirmada por el proveedor. El estado de EC2 no verifica la salud
              de sus aplicaciones.
            </p>
          )}
        </>
      ) : (
        <p role="status">
          {query.error
            ? "No se pudo encontrar la orden."
            : "Consultando orden…"}
        </p>
      )}
      {!!query.error && (
        <Banner tone="warn" glyph="bang" title="No se pudo actualizar la orden">
          Conservamos el último resultado disponible. No se repite la orden.
        </Banner>
      )}
    </div>
  );
}
