import { useRef, useState } from "react";
import type { SecretGrant, SecretRequest, SecretRequestState } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { useSession } from "../app/Session.tsx";
import { provider } from "../app/providers.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { useRead } from "../hooks/useRead.ts";
import { useOperationalRefresh } from "./Activity.tsx";
import { age } from "../lib/controlModel.ts";
import { projectLabel } from "../lib/secrets.ts";
import { countdown, deadlineText, historyChips, knownCollections, tokenMachines, type Collection, type HistoryFilter } from "../lib/agentsModel.ts";
import { useLoadMore } from "../lib/agentsPaging.ts";
import { Icon } from "../components/ui.tsx";
import { Card, Chip, Chips, Empty, Hint, IconTile, Pill, Row, Rows, ScreenHead, SearchField, type V2Tone } from "../components/v2.tsx";
import { Declared, KeyTile, LoadMore, ReadGate, Verified } from "../components/ag-ui.tsx";
import { DecisionDialog } from "../components/DecisionDialog.tsx";

const SHORT_STATE: Readonly<Record<SecretRequestState, { label: string; tone: V2Tone }>> = {
  pending: { label: "Te espera", tone: "key" },
  approved: { label: "Aprobada", tone: "busy" },
  delivered: { label: "Entregada", tone: "ok" },
  denied: { label: "Denegada", tone: "neutral" },
  expired: { label: "Venció", tone: "stale" },
  failed: { label: "Falló", tone: "bad" },
};
export function shortState(state: string): { label: string; tone: V2Tone } {
  return Object.hasOwn(SHORT_STATE, state) ? SHORT_STATE[state as SecretRequestState] : { label: "Desconocido", tone: "unc" };
}

export function Agents() {
  const app = useAppState(); const { expire } = useSession();
  const [query, setQuery] = useState(""); const [filter, setFilter] = useState<HistoryFilter>("");
  const pending = useLoadMore(provider.getPendingSecretRequests, {}, { identity: "agents-pending", onUnauthorized: expire, items: page => page.requests, key: (r: SecretRequest) => r.id });
  const grants = useLoadMore(provider.getSecretGrants, {}, { identity: "agents-grants", onUnauthorized: expire, items: page => page.grants, key: (g: SecretGrant) => g.id });
  const history = useLoadMore(provider.getSecretRequests, { q: query, state: filter || undefined }, { identity: "agents-requests", onUnauthorized: expire, items: page => page.requests, key: (r: SecretRequest) => r.id });
  const counts = useRead(provider.getSecretRequestCounts, true, null, expire, true, { identity: "agents-counts" });
  useOperationalRefresh(pending, 60000); useOperationalRefresh(grants, 60000); useOperationalRefresh(history, 60000); useOperationalRefresh(counts, 60000);

  const total = pending.data && !pending.error ? pending.data.pendingCount : null;
  const detail = total === null ? undefined : total === 0 ? "Nada te espera." : total === 1 ? "1 petición te espera." : `${total} peticiones te esperan.`;
  const loadedRequests = [...pending.items, ...history.items];
  return <div className="page ag">
    <ScreenHead title="Agentes" detail={detail} avatar />
    <div className="v2-grid v2-grid--2">
      <div className="v2-stack">
        <Card title="Te espera" meta={total ?? undefined} flush id="ag-pending">
          <ReadGate read={pending} label="las peticiones pendientes">
            {pending.items.length > 0 ? <Rows label="Peticiones pendientes">{pending.items.map(r => { const c = countdown(r, app.now); return <li key={r.id}><Row to={{ name: "secretRequest", id: r.id }} lead={<KeyTile fraction={c.fraction} />} title={<span className="ag-mono">{r.name}</span>} sub={<>{r.machine} · <b className={c.expired || !c.known ? undefined : "ag-urgent"}>{deadlineText(c)}</b> · {projectLabel(r)}</>} trailing={<span className="v2-pill ag-review">Revisar</span>} chevron={false} /></li>; })}</Rows> : <Empty title="Nada te espera." />}
            <LoadMore list={pending} label="peticiones pendientes" />
          </ReadGate>
        </Card>
        <History history={history} counts={counts.data?.counts ?? null} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} />
      </div>
      <div className="v2-stack">
        <Grants grants={grants} />
        <Machines requests={loadedRequests} grants={grants.items} ready={!!history.data && !!grants.data} />
        <Vault collections={knownCollections([...loadedRequests, ...grants.items])} />
        <Card flush label="Auditoría"><Rows><li><Row to={{ name: "activity" }} lead={<IconTile><Icon name="activity" /></IconTile>} title="Auditoría de claves" sub="En Actividad › Claves" /></li></Rows></Card>
      </div>
    </div>
  </div>;
}

type Paged<I> = ReturnType<typeof useLoadMore<{ nextCursor: string | null; hasMore: boolean }, I>>;

function History({ history, counts, query, setQuery, filter, setFilter }: { history: Paged<SecretRequest>; counts: Record<string, number> | null; query: string; setQuery: (q: string) => void; filter: HistoryFilter; setFilter: (f: HistoryFilter) => void }) {
  const app = useAppState();
  return <Card title="Historial" flush id="ag-history">
    <div className="ag-tools">
      <SearchField value={query} onChange={setQuery} placeholder="Clave, equipo, agente o proyecto" label="Buscar agentes o peticiones" />
      <Chips label="Estado de petición">{historyChips(counts, filter, query.trim().length > 0).map(chip => <Chip key={chip.key || "all"} pressed={filter === chip.key} count={chip.count} onClick={() => setFilter(chip.key)}>{chip.label}</Chip>)}</Chips>
    </div>
    <ReadGate read={history} label="el historial" rows={3}>
      {history.items.length > 0 ? <Rows label="Historial de peticiones">{history.items.map(r => { const view = shortState(r.state); return <li key={r.id}><Row to={{ name: "secretRequest", id: r.id }} lead={<span className={`v2-dot v2-dot--${view.tone}`} aria-hidden="true" />} title={<span className="ag-mono">{r.name}</span>} sub={<>{r.machine} · {projectLabel(r)}{r.auto ? " · por permiso" : ""}</>} age={age(r.createdAt, app.now)} trailing={<Pill tone={view.tone}>{view.label}</Pill>} /></li>; })}</Rows> : <Empty title={query.trim() || filter ? "Nada coincide con este filtro." : "Aún no hay peticiones."} />}
      <LoadMore list={history} label="peticiones del historial" />
    </ReadGate>
  </Card>;
}

function Grants({ grants }: { grants: Paged<SecretGrant> }) {
  const app = useAppState(); const { expire } = useSession();
  const [revokeId, setRevokeId] = useState<string | null>(null); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [retryAt, setRetryAt] = useState(0); const [error, setError] = useState<string | null>(null);
  const writeReason = !app.online ? "Sin conexión." : !app.visible ? "Vuelve a la app." : busy ? "Revocación en curso." : app.now < retryAt ? "Respeta el tiempo de espera del servidor." : grants.error || !grants.data ? "Primero comprueba la lista de permisos." : null;
  const revoke = async () => {
    if (!revokeId || lock.current || writeReason) return;
    lock.current = true; setBusy(true); setError(null);
    try { const result = await provider.revokeSecretGrant(revokeId); if (!result.revoked) setError("El servidor no confirmó una revocación nueva; vuelvo a leer la lista."); grants.reset(); setRevokeId(null); }
    catch (failure) { setError(failure instanceof ProviderError && failure.ambiguous ? "No se confirmó la revocación. Comprueba la lista antes de repetir." : "No se pudo revocar el permiso."); if (failure instanceof ProviderError) { if (failure.status === 401) expire(); if (failure.retryAfterSeconds) setRetryAt(Date.now() + failure.retryAfterSeconds * 1000); } }
    finally { lock.current = false; setBusy(false); }
  };
  const close = () => { if (!busy) setRevokeId(null); };
  return <Card title="Permisos" flush id="ag-grants">
    <ReadGate read={grants} label="los permisos">
      {grants.items.length > 0 ? <Rows label="Permisos activos">{grants.items.map(g => <li key={g.id}><Row lead={<IconTile tone="key"><Icon name="key" /></IconTile>} title={<span className="ag-mono">{g.name}</span>} sub={<>{g.agent} · {projectLabel(g)} · {g.scope === "always" ? "cualquier equipo" : g.machine}</>} age={age(g.createdAt, app.now)} trailing={<button className="v2-pill ag-revoke" type="button" disabled={writeReason !== null} onClick={() => { setError(null); setRevokeId(g.id); }}>Revocar</button>} /></li>)}</Rows> : <Empty title="Ningún agente recibe claves sin preguntarte." />}
      {grants.items.length > 0 && writeReason && <p className="ag-line">Revocar: {writeReason}</p>}
      {error && !revokeId && <p className="ag-line ag-line--bad" role="alert">{error}</p>}
      <LoadMore list={grants} label="permisos" />
    </ReadGate>
    {revokeId && <DecisionDialog title="¿Revocar este permiso?" onCancel={close} actions={<><button className="btn" type="button" onClick={close}>Cancelar</button><button className="btn btn--primary" type="button" disabled={writeReason !== null} onClick={() => void revoke()}>Confirmar revocación</button>{writeReason && <p className="t-small">{writeReason}</p>}</>}><p>El agente dejará de recibirla sin preguntarte. La credencial seguirá vigente en su proveedor.</p>{error && <p role="alert" className="field-error">{error}</p>}</DecisionDialog>}
  </Card>;
}

function Machines({ requests, grants, ready }: { requests: readonly SecretRequest[]; grants: readonly SecretGrant[]; ready: boolean }) {
  const app = useAppState();
  const machines = tokenMachines(requests, grants);
  return <>
    <Card title="Equipos con token" flush id="ag-machines">
      {machines.length > 0 ? <Rows label="Equipos con token">{machines.map(m => <li key={m.machine}><Row lead={<IconTile tone={m.pending ? "key" : "neutral"}><Icon name="pc" /></IconTile>} title={<>{m.machine} <Verified /></>} sub={<>{m.agents.join(", ")} <Declared /></>} age={age(m.lastAt, app.now)} trailing={m.pending ? <Pill tone="key">{m.pending} te espera</Pill> : undefined} /></li>)}</Rows> : ready ? <Empty title="Ningún equipo ha pedido claves." /> : <Empty title="Leyendo equipos…" />}
    </Card>
    <Hint>El equipo está verificado; agente y motivo los declara él.</Hint>
  </>;
}

function Vault({ collections }: { collections: Collection[] }) {
  const app = useAppState(); const { expire } = useSession();
  const [collection, setCollection] = useState<{ project: string; environment: string | null } | null>(null);
  const [searching, setSearching] = useState(false);
  const [project, setProject] = useState(""); const [environment, setEnvironment] = useState("");
  const identity = JSON.stringify(collection ? [collection.project, collection.environment] : null);
  const items = useRead(() => { const chosen = collection!; return provider.getSecretItems(chosen.project, chosen.environment); }, collection !== null, null, expire, false, { identity });
  const wait = !app.online ? "Sin conexión." : !app.visible ? "Vuelve a la app para consultar." : app.now < items.retryAt ? "El servidor pidió esperar antes de otra consulta." : null;
  const open = (next: { project: string; environment: string | null }) => {
    if (wait) return;
    if (collection?.project === next.project && collection.environment === next.environment) items.refresh();
    else setCollection(next);
  };
  const isOpen = (c: { project: string; environment: string | null }) => collection?.project === c.project && collection.environment === c.environment;
  return <Card title="Claves guardadas" meta="solo nombres" id="ag-vault" className="ag-vault">
    {collections.length > 0 && <Chips label="Colecciones conocidas">{collections.map(c => <Chip key={c.key} pressed={isOpen(c)} onClick={() => open(c)}>{projectLabel(c)}</Chip>)}</Chips>}
    {collection && <div className="ag-vault__list">
      <h3 className="ag-vault__title">{projectLabel(collection)}</h3>
      <ReadGate read={items} label="los nombres" rows={2}>
        {items.data && (items.data.items.length > 0 ? <Rows label={`Claves de ${projectLabel(collection)}`}>{items.data.items.map(item => <li key={item.itemRef}><Row lead={<span className="v2-dot v2-dot--neutral" aria-hidden="true" />} title={<span className="ag-mono">{item.name}</span>} age={age(item.updatedAt, app.now)} /></li>)}</Rows> : <Empty title="No hay claves en esta colección." />)}
      </ReadGate>
    </div>}
    <button type="button" className="ag-disclose" aria-expanded={searching} onClick={() => setSearching(v => !v)}>Buscar otra colección<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
    {searching && <form className="ag-form" onSubmit={event => { event.preventDefault(); if (project.trim()) open({ project: project.trim(), environment: environment.trim() || null }); }}>
      <label className="ag-field"><span className="ag-field__label">Proyecto de la colección</span><input className="ag-input" value={project} onChange={event => setProject(event.target.value)} autoCapitalize="none" spellCheck={false} /></label>
      <label className="ag-field"><span className="ag-field__label">Entorno de la colección</span><input className="ag-input" value={environment} onChange={event => setEnvironment(event.target.value)} placeholder="opcional" autoCapitalize="none" spellCheck={false} /></label>
      <button type="submit" className="btn ag-btn" disabled={!project.trim() || wait !== null}>Consultar nombres</button>
      {wait && <p className="ag-line">{wait}</p>}
    </form>}
  </Card>;
}
