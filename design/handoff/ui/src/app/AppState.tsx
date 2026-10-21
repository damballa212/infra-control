import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CostReport, Operation, OperationRequest, Resource } from "../contract.ts";
import { provider, isFixture } from "./providers.ts";
import { useSession } from "./Session.tsx";
import { useRead } from "../hooks/useRead.ts";
import { useOnline, usePageVisible, useNow } from "../hooks/usePlatform.ts";
import { isActiveOperation } from "../lib/status.ts";
import { IntentController } from "../lib/intent.ts";
import { ProviderError } from "../../../integration/provider.ts";
function useAppData() {
  const { expire } = useSession();
  const online = useOnline();
  const visible = usePageVisible();
  const now = useNow();
  const latestPc = useRef<Resource | null>(null);
  const pcRevision = useRef(0);
  const inventory = useRead(async () => {
    const startedRevision = pcRevision.current;
    const snapshot = await provider.getResources();
    const recent = latestPc.current;
    if (recent && startedRevision !== pcRevision.current) snapshot.resources = snapshot.resources.map(r => r.id === recent.id ? recent : r);
    return snapshot;
  }, true, 60000, expire);
  const inventoryReady = inventory.data !== null;
  useEffect(() => {
    if (isFixture || !online || !visible || !inventoryReady || typeof EventSource === "undefined") return;
    const stream = new EventSource("/api/events");
    stream.addEventListener("desktop", (event: MessageEvent<string>) => {
      try {
        const pc = JSON.parse(event.data) as Resource;
        if (pc.id !== "computer:desktop" || pc.kind !== "computer" || !Array.isArray(pc.actions)) return;
        if (latestPc.current && Date.parse(pc.observedAt ?? '') < Date.parse(latestPc.current.observedAt ?? '')) return;
        latestPc.current = pc;
        pcRevision.current += 1;
        inventory.setData(previous => ({ ...(previous ?? { fetchedAt: new Date().toISOString(), refreshSeconds: 60 }), resources: (previous?.resources ?? [pc]).map(r => r.id === pc.id ? pc : r) }));
      } catch { /* A malformed event cannot mutate the current inventory. */ }
    });
    return () => stream.close();
  }, [online, visible, inventoryReady, inventory.setData]);
  const [opsPolling, setOpsPolling] = useState(true);
  const operations = useRead(
    async () => {
      const value = await provider.getOperations();
      setOpsPolling(value.operations.some(isActiveOperation));
      return value;
    },
    true,
    opsPolling ? 5000 : null,
    expire,
    true,
  );
  const previousActive = useRef(new Set<string>());
  useEffect(() => {
    const rows = operations.data?.operations ?? [];
    if (rows.some(o => previousActive.current.has(o.id) && !isActiveOperation(o))) inventory.refresh();
    previousActive.current = new Set(rows.filter(isActiveOperation).map(o => o.id));
  }, [operations.data, inventory.refresh]);
  const [costsEnabled, enableCosts] = useState(false);
  const costs = useRead<CostReport>(
    provider.getCosts,
    costsEnabled,
    null,
    expire,
  );
  const [sending, setSending] = useState(false);
  const [writeError, setWriteError] = useState<unknown>(null);
  const [retryAt, setRetryAt] = useState(0);
  const intent = useRef(
    new IntentController<Operation>(provider.createOperation),
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // In-flight results are scoped to this authenticated tree; it is unmounted on logout/401.
  const attach = (operation: Operation) => {
    operations.setData((previous) => ({
      operations: [
        operation,
        ...(previous?.operations ?? []).filter((o) => o.id !== operation.id),
      ],
    }));
    if (isActiveOperation(operation)) setOpsPolling(true);
  };
  const submit = async (request?: OperationRequest) => {
    if (!online || !visible || sending || Date.now() < retryAt)
      throw new Error("Espera antes de enviar otra orden");
    if (
      request &&
      (inventory.loading ||
        inventory.error ||
        !inventory.data ||
        operations.error ||
        !operations.data)
    )
      throw new Error("Primero comprueba el inventario y la actividad");
    setSending(true);
    setWriteError(null);
    try {
      const operation = await (request
        ? intent.current.submit(request)
        : intent.current.recover());
      if (mounted.current) attach(operation);
      return operation;
    } catch (error) {
      if (mounted.current) {
        setWriteError(error);
        if (error instanceof ProviderError) {
          if (error.status === 401) expire();
          if (error.retryAfterSeconds)
            setRetryAt(Date.now() + error.retryAfterSeconds * 1000);
        }
      }
      throw error;
    } finally {
      if (mounted.current) setSending(false);
    }
  };
  return {
    inventory,
    operations,
    costs,
    enableCosts,
    online,
    visible,
    now,
    sending,
    writeError,
    retryAt,
    ambiguous: intent.current.ambiguous,
    ambiguousResource: intent.current.resourceId,
    submit,
    attach,
    canWrite:
      online &&
      visible &&
      !inventory.loading &&
      !inventory.error &&
      inventory.data !== null &&
      !operations.error &&
      operations.data !== null &&
      !sending &&
      !intent.current.ambiguous &&
      now >= retryAt,
  };
}
type AppData = ReturnType<typeof useAppData>;
const Context = createContext<AppData | null>(null);
export function AppStateProvider({ children }: { children: ReactNode }) {
  const value = useAppData();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAppState() {
  const value = useContext(Context);
  if (!value) throw new Error("Falta AppState");
  return value;
}
