import { useCallback, useEffect, useRef, useState } from "react";
import { ProviderError } from "../../../integration/provider.ts";
import { nextDelayMs } from "../lib/poller.ts";
import { useOnline, usePageVisible } from "./usePlatform.ts";

export interface ReadState<T> { data: T | null; error: unknown; loading: boolean; retryAt: number }
export interface ReadOptions<T> {
  identity?: string;
  /** Colecciones compartidas pueden reconciliar con su almacén síncrono. */
  merge?: (incoming: T, current: T | null) => T;
}
/** Una lectura en vuelo; refresh se conserva aunque llegue durante otra lectura. */
export function useRead<T>(load: () => Promise<T>, enabled: boolean, interval: number | null, onUnauthorized: () => void, refreshOnResume = false, options: ReadOptions<T> = {}) {
  const identity = options.identity ?? "default";
  const [state, setState] = useState<ReadState<T> & { identity: string }>({ data: null, error: null, loading: false, retryAt: 0, identity });
  const stateRef = useRef(state);
  const [revision, setRevision] = useState(0);
  const visible = usePageVisible(); const online = useOnline();
  const lifecycle = useRef(0); const live = useRef(false);
  const inFlight = useRef(false); const failures = useRef(0); const nextAt = useRef(0);
  const loadedIdentity = useRef<string | null>(null); const paused = useRef(false);
  const requestedRevision = useRef(0); const mutationRevision = useRef(0);
  const config = useRef({ load, onUnauthorized, identity, merge: options.merge });
  config.current = { load, onUnauthorized, identity, merge: options.merge };
  const publish = useCallback((value: typeof state) => { stateRef.current = value; setState(value); }, []);
  useEffect(() => { live.current = true; lifecycle.current += 1; return () => { live.current = false; lifecycle.current += 1; }; }, []);
  const refresh = useCallback(() => {
    requestedRevision.current += 1; loadedIdentity.current = null;
    // Una invalidación puede adelantar la cadencia sana, nunca el backoff del endpoint.
    if (Date.now() >= stateRef.current.retryAt) nextAt.current = 0;
    setRevision(v => v + 1);
  }, []);
  const setData = useCallback((update: (previous: T | null) => T) => {
    mutationRevision.current += 1;
    const previous = stateRef.current;
    const key = config.current.identity;
    publish({ ...previous, identity: key, data: update(previous.identity === key ? previous.data : null) });
  }, [publish]);
  const getState = useCallback((): ReadState<T> => {
    const value = stateRef.current;
    return value.identity === config.current.identity ? value : { data: null, error: null, loading: true, retryAt: value.retryAt };
  }, []);
  useEffect(() => {
    if (!enabled || !visible || !online) { paused.current = true; return; }
    if (paused.current && refreshOnResume) loadedIdentity.current = null;
    paused.current = false;
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => { if (!stopped) { clearTimeout(timer); timer = setTimeout(() => void run(), ms); } };
    const run = async () => {
      if (stopped) return;
      if (inFlight.current) { schedule(100); return; }
      if (Date.now() < nextAt.current) { schedule(nextAt.current - Date.now()); return; }
      if (interval === null && loadedIdentity.current === identity) return;
      const source = config.current;
      const life = lifecycle.current;
      const requested = requestedRevision.current; const mutations = mutationRevision.current;
      inFlight.current = true;
      const prior = stateRef.current;
      publish({ ...prior, identity, data: prior.identity === identity ? prior.data : null, error: prior.identity === identity ? prior.error : null, loading: true });
      try {
        const data = await source.load();
        if (!live.current || lifecycle.current !== life) return;
        if (source.identity !== config.current.identity) return;
        failures.current = 0;
        loadedIdentity.current = requested === requestedRevision.current ? identity : null;
        const current = stateRef.current;
        const merged = config.current.merge ? config.current.merge(data, current.data) : mutations !== mutationRevision.current && current.data !== null ? current.data : data;
        nextAt.current = requested !== requestedRevision.current || interval === null ? 0 : Date.now() + interval;
        publish({ data: merged, error: null, loading: false, retryAt: 0, identity });
        if (!stopped && requested !== requestedRevision.current) { nextAt.current = 0; schedule(0); }
        else if (interval !== null) schedule(interval);
      } catch (error) {
        if (!live.current || lifecycle.current !== life) return;
        if (error instanceof ProviderError && error.status === 401) { source.onUnauthorized(); return; }
        failures.current += 1;
        const delay = nextDelayMs({ baseMs: interval ?? 60000, failures: failures.current, retryAfterSeconds: error instanceof ProviderError ? error.retryAfterSeconds : null, random: Math.random() });
        nextAt.current = Date.now() + delay;
        // La espera pertenece al endpoint, pero el error y las filas pertenecen a su consulta.
        const current = stateRef.current;
        const key = config.current.identity;
        if (source.identity !== key) {
          publish({ identity: key, data: current.identity === key ? current.data : null, error: current.identity === key ? current.error : null, loading: false, retryAt: nextAt.current });
          return;
        }
        publish({ ...current, loading: false, error, retryAt: nextAt.current });
        schedule(delay);
      } finally {
        inFlight.current = false;
        // Otro efecto puede estar esperando este vuelo. Nunca programa desde un efecto cancelado.
        if (!stopped && stateRef.current.loading && live.current && lifecycle.current === life) publish({ ...stateRef.current, loading: false });
      }
    };
    void run();
    return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, visible, online, interval, revision, refreshOnResume, identity, publish]);
  const current = state.identity === identity ? state : { data: null, error: null, loading: enabled && visible && online, retryAt: state.retryAt };
  return { data: current.data, error: current.error, loading: current.loading, retryAt: current.retryAt, refresh, setData, getState };
}
