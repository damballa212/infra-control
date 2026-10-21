import { useCallback, useEffect, useRef, useState } from "react";
import { ProviderError } from "../../../integration/provider.ts";
import { nextDelayMs } from "../lib/poller.ts";
import { useOnline, usePageVisible } from "./usePlatform.ts";
export interface ReadState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  retryAt: number;
}
/** Non-overlapping reads; backoff persists through background/offline and manual refresh. */
export function useRead<T>(
  load: () => Promise<T>,
  enabled: boolean,
  interval: number | null,
  onUnauthorized: () => void,
  refreshOnResume = false,
) {
  const [state, setState] = useState<ReadState<T>>({
    data: null,
    error: null,
    loading: false,
    retryAt: 0,
  });
  const [revision, setRevision] = useState(0);
  const visible = usePageVisible();
  const online = useOnline();
  const live = useRef(true);
  const inFlight = useRef(false);
  const failures = useRef(0);
  const nextAt = useRef(0);
  const config = useRef({ load, onUnauthorized });
  config.current = { load, onUnauthorized };
  const loaded = useRef(false);
  const paused = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    if (!inFlight.current) {
      loaded.current = false;
      setRevision((v) => v + 1);
    }
  }, []);
  const setData = useCallback((update: (previous: T | null) => T) => {
    setState((s) => ({ ...s, data: update(s.data) }));
  }, []);
  useEffect(() => {
    if (!enabled || !visible || !online) {
      paused.current = true;
      return;
    }
    if (paused.current && refreshOnResume) loaded.current = false;
    paused.current = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      if (!stopped) timer = setTimeout(() => void run(), ms);
    };
    const run = async () => {
      if (stopped) return;
      if (inFlight.current) {
        schedule(100);
        return;
      }
      if (Date.now() < nextAt.current) {
        schedule(nextAt.current - Date.now());
        return;
      }
      if (interval === null && loaded.current) return;
      inFlight.current = true;
      setState((s) => ({ ...s, loading: true }));
      try {
        const data = await config.current.load();
        if (!live.current) return;
        loaded.current = true;
        failures.current = 0;
        nextAt.current = 0;
        setState({ data, error: null, loading: false, retryAt: 0 });
        if (interval !== null) {
          nextAt.current = Date.now() + interval;
          schedule(interval);
        }
      } catch (error) {
        if (!live.current) return;
        if (error instanceof ProviderError && error.status === 401) {
          config.current.onUnauthorized();
          return;
        }
        failures.current += 1;
        const delay = nextDelayMs({
          baseMs: interval ?? 60000,
          failures: failures.current,
          retryAfterSeconds:
            error instanceof ProviderError ? error.retryAfterSeconds : null,
          random: Math.random(),
        });
        nextAt.current = Date.now() + delay;
        setState((s) => ({
          ...s,
          loading: false,
          error,
          retryAt: nextAt.current,
        }));
        schedule(delay);
      } finally {
        inFlight.current = false;
      }
    };
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, visible, online, interval, revision, refreshOnResume]);
  return { ...state, refresh, setData };
}
