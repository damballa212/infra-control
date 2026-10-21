import { useState } from "react";
import { useAppState } from "../app/AppState.tsx";
import type { Resource } from "../contract.ts";
import { FilterChips, SearchBox } from "../components/Fields.tsx";
import { Key } from "../components/Key.tsx";
import { Panel } from "../components/Panel.tsx";
import { ResourceRow } from "../components/ResourceRow.tsx";
import { Hermes } from "../components/Hermes.tsx";
import { SkyBackground } from "../components/SkyBackground.tsx";
import { formatAgo } from "../lib/format.ts";
import { describeResourceState, needsAttention } from "../lib/status.ts";

type Filter = "all" | "attention" | "on" | "off" | "home";

interface Group {
  key: string;
  title: string;
  order: number;
  rows: Resource[];
}

function groupOf(resource: Resource): Pick<Group, "key" | "title" | "order"> {
  if (resource.kind === "router" || resource.kind === "computer")
    return resource.account === "Casa"
      ? { key: "home", title: "CASA", order: 0 }
      : { key: `own:${resource.account}`, title: resource.account.toUpperCase(), order: 1 };
  if (resource.kind === "service")
    return { key: "coolify", title: "COOLIFY · VPS", order: 9 };
  return { key: `aws:${resource.account}`, title: `AWS · ${resource.account.toUpperCase()}`, order: 5 };
}

/** Lo que pide acción primero, luego lo encendido, al final lo apagado. */
function rank(resource: Resource): number {
  if (needsAttention(resource)) return 0;
  return describeResourceState(resource).tone === "on" ? 1 : describeResourceState(resource).tone === "off" ? 3 : 2;
}

function matches(resource: Resource, filter: Filter): boolean {
  if (filter === "attention") return needsAttention(resource);
  if (filter === "on") return describeResourceState(resource).tone === "on";
  if (filter === "off") return describeResourceState(resource).tone === "off";
  if (filter === "home") return resource.kind === "router" || resource.kind === "computer";
  return true;
}

function groupRows(resources: readonly Resource[]): Group[] {
  const groups = new Map<string, Group>();
  for (const resource of resources) {
    const meta = groupOf(resource);
    const group = groups.get(meta.key) ?? { ...meta, rows: [] };
    groups.set(meta.key, { ...group, rows: [...group.rows, resource] });
  }
  return [...groups.values()]
    .map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => rank(a) - rank(b)) }))
    .sort((a, b) => a.order - b.order);
}

/** Lectura más reciente del grupo: la hora a la que se miró, no cuándo cambió el equipo. */
function readAt(rows: readonly Resource[], now: number): string {
  const times = rows.flatMap((r) => (r.observedAt ? [Date.parse(r.observedAt)] : []));
  return times.length ? `Leído ${formatAgo(new Date(Math.max(...times)).toISOString(), now)}` : "Sin lectura";
}

export function Search() {
  const app = useAppState();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const query = q.toLocaleLowerCase("es").trim();
  const all = app.inventory.data?.resources ?? [];
  const attention = all.filter(needsAttention).length;
  const rows = all.filter(
    (r) =>
      (!query ||
        `${r.name} ${r.account} ${r.location}`.toLocaleLowerCase("es").includes(query)) &&
      matches(r, filter),
  );
  const groups = groupRows(rows);
  return (
    <>
      <SkyBackground />
      <header className="control-header">
        <div>
          <p className="t-label">{all.length} EQUIPOS</p>
          <h1 className="t-h2">Equipos</h1>
          <p className="control-header__fresh">
            {attention > 0
              ? `${attention} ${attention === 1 ? "necesita atención" : "necesitan atención"}`
              : "Todo en orden"}
          </p>
        </div>
      </header>
      <div className="eq-body">
        <div className="eq-search">
          <SearchBox
            label="Buscar equipos"
            placeholder="Nombre, cuenta o región"
            hideLabel
            value={q}
            onChange={setQ}
          />
        </div>
        <div className="eq-chips">
        <FilterChips
          label="Filtrar equipos"
          options={[
            { value: "all", label: "Todo" },
            { value: "attention", label: `Atención · ${attention}` },
            { value: "on", label: "Encendidos" },
            { value: "off", label: "Apagados" },
            { value: "home", label: "Casa" },
          ]}
          value={filter}
          onChange={setFilter}
        />
        </div>
        {groups.length ? (
          groups.map((group) => (
            <section key={group.key} aria-label={group.title} className="eq-group">
              <div className="eq-group__head">
                <h2 className="t-label sky-label">{group.title}</h2>
                <span className="eq-group__age">{readAt(group.rows, app.now)}</span>
              </div>
              <Panel tone="paper" accent="violet" flush>
                {group.rows.map((r) => (
                  <ResourceRow key={r.id} resource={r} now={app.now} />
                ))}
              </Panel>
            </section>
          ))
        ) : (
          <Panel tone="paper">
            <div className="empty">
              <Hermes mood="unsure" size={80} />
              <h2 className="t-h3">
                {q ? `Nada coincide con «${q}»` : "Ningún equipo en este filtro"}
              </h2>
              <p>Prueba con parte del nombre, la cuenta o la región.</p>
              <Key
                variant="sun"
                onClick={() => {
                  setQ("");
                  setFilter("all");
                }}
              >
                Quitar búsqueda y filtros
              </Key>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
