import { useEffect, useState, useSyncExternalStore } from "react";

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** Reloj para textos relativos ("hace 40 s"). Solo avanza con la página visible. */
export function useNow(intervalMs = 5000): number {
  const visible = usePageVisible();
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!visible) return undefined;
    setNow(Date.now());
    const handle = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [visible, intervalMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = (listener: () => void): (() => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", listener);
    return () => list.removeEventListener("change", listener);
  };
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** >= 701 px: navegación lateral y detalle junto a la lista. */
export function useIsWide(): boolean {
  return useMediaQuery("(min-width: 701px)");
}
