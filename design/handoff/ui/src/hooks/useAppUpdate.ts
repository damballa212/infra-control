import { useEffect, useState } from "react";
export function useAppUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    const inspect = () => {
      if (!disposed) setWaiting(registration?.waiting ?? null);
    };
    const update = () => {
      const worker = registration?.installing;
      worker?.addEventListener("statechange", inspect);
    };
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((value) => {
        registration = value;
        inspect();
        value.addEventListener("updatefound", update);
      })
      .catch(() => {
        /* Installation is optional; the online app remains available. */
      });
    return () => {
      disposed = true;
      registration?.removeEventListener("updatefound", update);
    };
  }, []);
  return {
    waiting,
    activate: () => {
      if (!waiting) return;
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => window.location.reload(),
        { once: true },
      );
      waiting.postMessage("ACTIVATE_UPDATE");
    },
  };
}
