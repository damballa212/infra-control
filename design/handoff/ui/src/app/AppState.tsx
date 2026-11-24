import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Action, AttentionSummary, CostReport, DetailedResource, Operation, OperationRequest, OperationsResponse, ResourcesSnapshotResponse } from "../contract.ts";
import { provider, isFixture } from "./providers.ts";
import { useSession } from "./Session.tsx";
import { useRead } from "../hooks/useRead.ts";
import { useOnline, usePageVisible, useNow } from "../hooks/usePlatform.ts";
import { isActiveOperation } from "../lib/status.ts";
import { actionBlocker } from "../lib/controlModel.ts";
import { eventSequence, LiveState } from "../lib/liveState.ts";
import { OperationReader } from "../lib/operationReader.ts";
import { IntentController } from "../lib/intent.ts";

import { ProviderError } from "../../../integration/provider.ts";
function validResource(value: Partial<DetailedResource>): value is DetailedResource { return typeof value.id === "string" && typeof value.name === "string" && typeof value.kind === "string" && typeof value.state === "string" && Array.isArray(value.actions); }
function validAttention(value: unknown): value is AttentionSummary {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<AttentionSummary>;
  if (typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt)) || !data.counts || !data.coverage) return false;
  const count = (input: unknown) => Number.isSafeInteger(input) && Number(input) >= 0;
  return ['attentionGroups', 'active', 'pendingReviews', 'openIncidents', 'unknownIncidents', 'coverageProblems'].every(key => count((data.counts as unknown as Record<string, unknown>)[key])) && ['scopes', 'healthy', 'partial', 'failed', 'stale'].every(key => count((data.coverage as unknown as Record<string, unknown>)[key])) && (data.pendingApprovals === undefined || count(data.pendingApprovals));
}
function useAppData() {
  const { expire, user } = useSession(); const online = useOnline(); const visible = usePageVisible(); const now = useNow();
  const store = useRef(new LiveState());
  const scope = useRef({ alive: true, epoch: 0, online, visible }); scope.current.online = online; scope.current.visible = visible;
  const publishActivity = useRef<() => void>(() => {});
  const reader = useRef<OperationReader | null>(null);
  const endSession = useCallback(() => { scope.current.alive = false; scope.current.epoch += 1; reader.current?.deactivate(); expire(); }, [expire]);
  if (!reader.current) reader.current = new OperationReader({ store: store.current, get: id => provider.getOperation(id), available: () => scope.current.alive && scope.current.online && navigator.onLine && scope.current.visible && document.visibilityState !== "hidden", changed: () => publishActivity.current(), unauthorized: endSession });
  useEffect(() => { scope.current.alive = true; scope.current.epoch += 1; reader.current!.activate(); return () => { scope.current.alive = false; scope.current.epoch += 1; reader.current!.deactivate(); }; }, []);
  const inventoryRead = useRead(async () => {
    const epoch = scope.current.epoch; const started = store.current.begin(); const snapshot = await provider.getResources();
    if (!scope.current.alive || epoch !== scope.current.epoch) throw new Error("La sesión cambió durante la lectura");
    return store.current.acceptInventory(snapshot, started);
  }, true, 60000, endSession, false, { merge: incoming => store.current.inventory() ?? incoming });
  const [opsPolling, setOpsPolling] = useState(true);
  const listFailure = useRef<unknown>(null);
  const operationsRead = useRead(async () => {
    // Una recuperación individual en backoff no invalida la lista ya autorizada.
    if (Date.now() < reader.current!.retryAt && store.current.activity()) {
      if (listFailure.current !== null) throw listFailure.current;
      return store.current.activity()!;
    }
    reader.current!.checkDeadline();
    const epoch = scope.current.epoch; const started = store.current.begin();
    let snapshot: OperationsResponse;
    try { snapshot = await provider.getOperations(); } catch (failure) { if (scope.current.alive && epoch === scope.current.epoch) { listFailure.current = failure; reader.current!.defer(failure); } throw failure; }
    if (!scope.current.alive || epoch !== scope.current.epoch) throw new Error("La sesión cambió durante la lectura");
    listFailure.current = null;
    store.current.acceptOperations(snapshot, started);
    publishActivity.current();
    try { await reader.current!.recoverOutside(new Set(snapshot.operations.map(operation => operation.id)), started, 2); }
    catch (failure) { if (failure instanceof ProviderError && failure.status === 401) throw failure; }
    if (!scope.current.alive || epoch !== scope.current.epoch) throw new Error("La sesión cambió durante la recuperación");
    return store.current.activity()!;
  }, true, opsPolling ? 5000 : null, endSession, true, { merge: incoming => store.current.activity() ?? incoming });
  publishActivity.current = () => { if (scope.current.alive) { operationsRead.setData(() => store.current.activity()!); if (store.current.activity()?.operations.some(isActiveOperation)) setOpsPolling(true); } };
  const readOperation = useCallback((id: string) => reader.current!.read(id), []);
  const setInventory = useCallback((update: (previous: ResourcesSnapshotResponse | null) => ResourcesSnapshotResponse) => { const next = store.current.replaceInventory(update(store.current.inventory())); inventoryRead.setData(() => next); }, [inventoryRead.setData]);
  const setOperations = useCallback((update: (previous: OperationsResponse | null) => OperationsResponse) => { const next = store.current.replaceOperations(update(store.current.activity())); operationsRead.setData(() => next); }, [operationsRead.setData]);
  const inventory = { ...inventoryRead, setData: setInventory }; const operations = { ...operationsRead, setData: setOperations };
  const attention = useRead(provider.getAttentionSummary, true, 60000, endSession, true);
  useEffect(() => { const changed = () => attention.refresh(); window.addEventListener('infra:operation-review', changed); return () => window.removeEventListener('infra:operation-review', changed); }, [attention.refresh]);
  const attach = useCallback((operation: Operation) => { if (!scope.current.alive || !store.current.attach(operation)) return; operationsRead.setData(() => store.current.activity()!); if (isActiveOperation(operation)) setOpsPolling(true); }, [operationsRead.setData]);
  useEffect(() => { const rows = operationsRead.data?.operations; if (rows) setOpsPolling(rows.some(isActiveOperation)); }, [operationsRead.data]);
  const inventoryReady = inventoryRead.data !== null;
  useEffect(() => {
    if (isFixture || !online || !visible || !inventoryReady || typeof EventSource === "undefined") return;
    const epoch = scope.current.epoch; const stream = new EventSource(`/api/events?cursor=${store.current.cursor}`);
    let resourceRefreshTimer: number | undefined;
    const current = () => scope.current.alive && scope.current.epoch === epoch;
    const operationalChanged = () => { if (current()) { attention.refresh(); window.dispatchEvent(new Event('infra:operational-change')); } };
    stream.addEventListener('open', operationalChanged);
    stream.addEventListener('attention', (event: MessageEvent<string>) => {
      if (!current()) return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!validAttention(value)) return;
        attention.setData(previous => previous && Date.parse(previous.fetchedAt) > Date.parse(value.fetchedAt) ? previous : value);
        window.dispatchEvent(new Event('infra:operational-change'));
      } catch { /* No se publica un resumen inválido. */ }
    });
    for (const type of ['coverage', 'incident', 'incident-state']) stream.addEventListener(type, operationalChanged);
    const refreshCatalog = () => { if (!current() || resourceRefreshTimer !== undefined) return; resourceRefreshTimer = window.setTimeout(() => { resourceRefreshTimer = undefined; if (current()) { inventoryRead.refresh(); attention.refresh(); } }, 150); };
    const resourceEvent = (event: MessageEvent<string>, desktop: boolean) => {
      if (!current()) return;
      try { const value = JSON.parse(event.data) as Partial<DetailedResource>; if (!validResource(value) || desktop && (value.id !== "computer:desktop" || value.kind !== "computer")) { if (!desktop) refreshCatalog(); return; } if (store.current.resourceEvent(value, eventSequence(event.lastEventId))) inventoryRead.setData(() => store.current.inventory()!); }
      catch { if (!desktop) refreshCatalog(); }
    };
    stream.addEventListener("desktop", (event: MessageEvent<string>) => resourceEvent(event, true));
    stream.addEventListener("resource", (event: MessageEvent<string>) => resourceEvent(event, false));
    stream.addEventListener("operation", (event: MessageEvent<string>) => {
      if (!current()) return;
      try { const operation = JSON.parse(event.data) as Operation; if (typeof operation.id !== "string" || typeof operation.resourceId !== "string" || typeof operation.state !== "string" || typeof operation.updatedAt !== "string") return; if (!store.current.attach(operation, eventSequence(event.lastEventId))) return; operationsRead.setData(() => store.current.activity()!); attention.refresh(); if (isActiveOperation(operation)) setOpsPolling(true); else inventoryRead.refresh(); } catch { /* Evento inválido. */ }
    });
    stream.addEventListener("resync", () => { if (current()) { inventoryRead.refresh(); operationsRead.refresh(); attention.refresh(); } });
    return () => { stream.close(); if (resourceRefreshTimer !== undefined) window.clearTimeout(resourceRefreshTimer); };
  }, [online, visible, inventoryReady, inventoryRead.setData, inventoryRead.refresh, operationsRead.setData, operationsRead.refresh, attention.refresh, attention.setData]);
  const previousActive = useRef(new Set<string>());
  useEffect(() => { const rows = operationsRead.data?.operations ?? []; if (rows.some(o => previousActive.current.has(o.id) && !isActiveOperation(o))) inventoryRead.refresh(); previousActive.current = new Set(rows.filter(isActiveOperation).map(o => o.id)); }, [operationsRead.data, inventoryRead.refresh]);
  const secretRequests = useRead(provider.getSecretRequests, !!user && !user.agent, 30000, endSession, true);
  const secretsPending = !secretRequests.error && typeof secretRequests.data?.pendingCount === 'number' ? secretRequests.data.pendingCount : 0;
  const [costsEnabled, enableCosts] = useState(false); const costs = useRead<CostReport>(provider.getCosts, costsEnabled, null, endSession);
  const [sending, setSending] = useState(false); const sendingRef = useRef(false); const [writeError, setWriteError] = useState<unknown>(null);
  const [retryAt, setRetryAt] = useState(0); const retryRef = useRef(0); const intent = useRef(new IntentController<Operation>(provider.createOperation));
  const currentBlocker = useCallback((resourceId: string, action: Action): string | null => {
    const inventoryState = inventoryRead.getState(); const operationsState = operationsRead.getState(); const snapshot = store.current.inventory(); const activity = store.current.activity(); const resource = snapshot?.resources.find(row => row.id === resourceId);
    if (!scope.current.alive) return "Esta sesión ya no está activa."; if (!resource) return "El recurso ya no está en el inventario autorizado.";
    return actionBlocker(resource, action, { online: scope.current.online && navigator.onLine, visible: scope.current.visible && document.visibilityState !== "hidden", canWrite: true, sending: sendingRef.current, ambiguous: intent.current.ambiguous, now: Date.now(), retryAt: retryRef.current, inventory: { ...inventoryState, data: snapshot }, operations: { ...operationsState, data: activity } }, activity?.operations ?? []);
  }, [inventoryRead.getState, operationsRead.getState]);
  const submit = useCallback(async (request?: OperationRequest) => {
    if (!scope.current.alive || !scope.current.online || !navigator.onLine || !scope.current.visible || document.visibilityState === "hidden" || sendingRef.current || Date.now() < retryRef.current) throw new Error("Espera antes de enviar otra orden");
    if (request) { const blocker = currentBlocker(request.resourceId, request.action); if (blocker) throw new Error(blocker); if (request.action !== "refresh" && request.confirmed !== true) throw new Error("La orden de energía requiere confirmación"); }
    const epoch = scope.current.epoch; sendingRef.current = true; setSending(true); setWriteError(null);
    try { const operation = await (request ? intent.current.submit(request) : intent.current.recover()); if (scope.current.alive && scope.current.epoch === epoch) attach(operation); return operation; }
    catch (error) { if (scope.current.alive && scope.current.epoch === epoch) { setWriteError(error); if (error instanceof ProviderError) { if (error.status === 401) endSession(); if (error.retryAfterSeconds !== null) { retryRef.current = Math.max(retryRef.current, Date.now() + error.retryAfterSeconds * 1000); setRetryAt(retryRef.current); } } } throw error; }
    finally { sendingRef.current = false; if (scope.current.alive && scope.current.epoch === epoch) setSending(false); }
  }, [attach, currentBlocker, endSession]);
  return { inventory, operations, attention, costs, enableCosts, secretRequests, secretsPending, online, visible, now, sending, writeError, retryAt, ambiguous: intent.current.ambiguous, ambiguousResource: intent.current.resourceId, submit, attach, currentBlocker, readOperation, canWrite: online && visible && !inventory.loading && !inventory.error && inventory.data !== null && !operations.error && operations.data !== null && !sending && !intent.current.ambiguous && now >= retryAt };
}
type AppData = ReturnType<typeof useAppData>;
const Context = createContext<AppData | null>(null);
export function AppStateProvider({ children }: { children: ReactNode }) { const value = useAppData(); return <Context.Provider value={value}>{children}</Context.Provider>; }
export function useAppState() { const value = useContext(Context); if (!value) throw new Error("Falta AppState"); return value; }
