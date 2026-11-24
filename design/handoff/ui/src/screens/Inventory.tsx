import { useState } from "react";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { provider } from "../app/providers.ts";
import { useRead } from "../hooks/useRead.ts";
import { useMediaQuery } from "../hooks/usePlatform.ts";
import { navigate, type InventoryView } from "../lib/router.tsx";
import { age, matchesText } from "../lib/controlModel.ts";
import { activeResourceIds, bySeverity, groupItems, isProblem, isProduction, problemCounts, problemSummary, resourceItem, serviceItem, type InvItem } from "../lib/invModel.ts";
import { Card, Chip, Chips, Rows, ScreenHead, SearchField, Segmented, Skeleton } from "../components/v2.tsx";
import { ReadNotice } from "../components/ControlUI.tsx";
import { InfrastructureMap } from "../components/InfrastructureMap.tsx";
import { InvRow } from "../components/inv-rows.tsx";
import { InvPeek } from "../components/inv-peek.tsx";

const VIEWS = [["services", "Servicios"], ["devices", "Equipos"], ["map", "Mapa"]] as const;

export function Inventory({ view, problems = false }: { view: InventoryView; problems?: boolean }) {
  const app = useAppState();
  const { expire } = useSession();
  const wide = useMediaQuery("(min-width: 1101px)");
  const catalog = useRead(provider.getCatalogServices, true, 60000, expire);
  const [query, setQuery] = useState("");
  const [production, setProduction] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const setProblems = (next: boolean) => navigate({ name: "inventory", view, problems: next || undefined }, { replace: true });
  const resources = app.inventory.data?.resources ?? [];
  const services = catalog.data?.services ?? [];
  const activeIds = activeResourceIds(app.operations.data?.operations ?? []);

  const all: InvItem[] = view === "devices"
    ? resources.filter(r => !production || isProduction(r.catalog?.environment)).map(r => resourceItem(r, app.now, activeIds, services, resources))
    : view === "services" ? services.filter(s => s.active && (!production || isProduction(s.environment))).map(s => serviceItem(s, resources, app.now, activeIds)) : [];
  const matching = all.filter(item => matchesText(query, item.name, item.zone.title, item.zone.sub, item.label));
  const shown = problems ? matching.filter(item => isProblem(item.status)).sort(bySeverity) : matching;
  const counts = problemCounts(all);
  const read = view === "devices" ? app.inventory : catalog;
  const ready = !!read.data && (view === "devices" || !!app.inventory.data);
  const groups = problems ? [] : groupItems(shown);
  const ordered = problems ? shown : groups.flatMap(group => group.items);
  const selected = wide ? ordered.find(item => item.key === picked) ?? ordered[0] ?? null : null;
  const fresh = app.inventory.data?.fetchedAt;

  const head = <>
    <ScreenHead avatar title="Inventario" live={!app.online || app.inventory.error ? "off" : "on"} eyebrow={!app.online ? "Sin conexión" : fresh ? `${app.inventory.error ? "Lectura anterior" : "En vivo"} · ${age(fresh, app.now)}` : "Conectando"} />
    <div className="inv-controls">
      <SearchField value={query} onChange={setQuery} placeholder="Buscar servicios o equipos" label="Buscar servicios o equipos" />
      <Segmented label="Vistas de inventario" value={view} items={VIEWS.map(([key, label]) => ({ key, label, to: { name: "inventory" as const, view: key, problems: problems || undefined } }))} />
    </div>
  </>;

  if (view === "map") return <div className="page inv inv-mappage">
    {head}
    <ReadNotice read={app.inventory} label="el inventario" />
    {app.inventory.data ? <InfrastructureMap resources={resources} services={services} query={query} problems={problems} onProblems={setProblems} /> : !app.inventory.error && <Skeleton rows={3} label="Cargando el mapa" />}
  </div>;

  return <div className="page inv">
    {head}
    <Chips label="Filtros">
      <Chip pressed={!problems} onClick={() => setProblems(false)} count={ready ? all.length : undefined}>Todos</Chip>
      <Chip pressed={problems} onClick={() => setProblems(!problems)} dot={counts.bad ? "bad" : counts.total ? "stale" : undefined} count={ready ? counts.total : undefined}>Con problemas</Chip>
      <Chip pressed={production} onClick={() => setProduction(!production)}>Producción</Chip>
    </Chips>
    <div className="inv-notices"><ReadNotice read={read} label={view === "devices" ? "el inventario" : "el catálogo de servicios"} />{view === "services" && <ReadNotice read={app.inventory} label="el inventario" />}</div>
    {problems && ready && <section className={`inv-focus${counts.bad ? " inv-focus--bad" : counts.total ? " inv-focus--stale" : ""}`} aria-live="polite">
      <div className="inv-focus__text"><p className="v2-eyebrow">Con problemas · {view === "devices" ? "equipos" : "servicios"}</p><h2 className="inv-focus__title">{counts.total ? problemSummary(counts) : "Nada que revisar"}</h2></div>
      <Chip onClick={() => setProblems(false)}>Quitar filtro ✕</Chip>
    </section>}
    {!ready ? !read.error && <Skeleton rows={4} label="Cargando" /> : !shown.length ? <EmptyList query={query} problems={problems} view={view} /> :
      <div className={wide ? "v2-grid v2-grid--aside inv-grid" : "inv-grid"}>
        <div className="v2-stack inv-list">
          {problems ? <ItemCard title="Primero lo que falla" items={shown} selected={selected?.key ?? null} onPick={wide ? setPicked : undefined} />
            : groups.map(group => <ItemCard key={group.zone.key} title={group.zone.title} meta={[group.zone.sub, group.freshest ? age(group.freshest, app.now).replace("hace ", "") : null].filter(Boolean).join(" · ")} items={group.items} selected={selected?.key ?? null} onPick={wide ? setPicked : undefined} />)}
        </div>
        {wide && selected && <aside className="v2-sticky" aria-label="Inspector"><div className="v2-card inv-aside"><InvPeek item={selected} resources={resources} services={services} /></div></aside>}
      </div>}
  </div>;
}

function ItemCard({ title, meta, items, selected, onPick }: { title: string; meta?: string; items: InvItem[]; selected: string | null; onPick?: (key: string) => void }) {
  return <Card flush title={title} meta={meta || undefined}>
    <Rows label={title}>{items.map(item => <li key={item.key} className={onPick && item.key === selected ? "is-selected" : undefined}><InvRow item={item} onSelect={onPick ? () => onPick(item.key) : undefined} /></li>)}</Rows>
  </Card>;
}

function EmptyList({ query, problems, view }: { query: string; problems: boolean; view: InventoryView }) {
  return <div className="v2-card inv-empty" role="status">
    <h2 className="inv-empty__title">{query ? `Nada coincide con «${query}»` : problems ? "Nada que revisar" : view === "devices" ? "Sin equipos en este filtro" : "Sin servicios en este filtro"}</h2>
  </div>;
}
