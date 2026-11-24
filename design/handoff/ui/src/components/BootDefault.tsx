import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BootPreference, BootSystem } from "../contract.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { provider } from "../app/providers.ts";
import { useSession } from "../app/Session.tsx";
import { useRead } from "../hooks/useRead.ts";
import { useNow, useOnline, usePageVisible } from "../hooks/usePlatform.ts";
import { newIdempotencyKey } from "../lib/idempotency.ts";
import { SYSTEM_NAME, bootRowView, readBootPreference } from "../lib/bootDefault.ts";
import { Key } from "./Key.tsx";
export class BootActionCoordinator {
  private running = false; private deadline = 0; private revision = 0; private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }; snapshot = () => this.revision;
  private notify() { this.revision += 1; this.listeners.forEach(listener => listener()); }
  get retryAt() { return this.deadline; } get working() { return this.running; }
  blocker(): string | null { if (Date.now() < this.deadline) return `El servidor pidió esperar ${Math.ceil((this.deadline - Date.now()) / 1000)} s antes de cambiar, cancelar o comprobar el arranque.`; return this.running ? "Hay una consulta o cambio de arranque en curso." : null; }
  enter(): boolean { if (this.blocker()) return false; this.running = true; this.notify(); return true; }
  failure(error: unknown) { if (error instanceof ProviderError && error.retryAfterSeconds !== null) { this.deadline = Math.max(this.deadline, Date.now() + Math.max(0, error.retryAfterSeconds) * 1000); this.notify(); } }
  leave() { this.running = false; this.notify(); }
}
const sharedCoordinator = new BootActionCoordinator();
export interface BootDefaultState {
  preference: BootPreference | null; working: boolean; error: string | null; notice: string | null; blocker: string | null; retryAt: number;
  recoveryRequired: boolean; confirmationRevision: number; recover: () => Promise<void>;
  set: (system: BootSystem) => Promise<boolean>; cancel: () => Promise<void>; verify: () => Promise<void>; clearMessages: () => void;
}
function messageOf(error: unknown): string { return error instanceof ProviderError ? error.ambiguous ? "No se confirmó la respuesta. Comprueba el estado antes de repetir." : error.message : "No se pudo completar la solicitud."; }
export function useBootDefault(coordinator = sharedCoordinator): BootDefaultState {
  const { expire } = useSession(); const online = useOnline(); const visible = usePageVisible(); useNow(1000); useSyncExternalStore(coordinator.subscribe, coordinator.snapshot, coordinator.snapshot);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false); const uncertainRef = useRef(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false); const recoveryRef = useRef(false); const [confirmationRevision, invalidateConfirmation] = useState(0);
  const mounted = useRef(false); const generation = useRef(0); const context = useRef({ online, visible }); context.current = { online, visible };
  useEffect(() => { mounted.current = true; generation.current += 1; return () => { mounted.current = false; generation.current += 1; }; }, []);
  const read = useRead(async () => {
    if (!coordinator.enter()) throw new ProviderError({ kind: "http", status: 503, retryAfterSeconds: Math.max(1, Math.ceil((coordinator.retryAt - Date.now()) / 1000)), message: coordinator.blocker() ?? "Espera antes de consultar" });
    try { const value = readBootPreference(await provider.getBootPreference()); if (!value) throw new Error("invalid-preference"); return value; } catch (failure) { coordinator.failure(failure); throw failure; } finally { coordinator.leave(); }
  }, true, null, expire);
  const allowedContext = useCallback(() => mounted.current && context.current.online && navigator.onLine && context.current.visible && document.visibilityState !== "hidden", []);
  const run = useCallback(async (action: () => Promise<BootPreference>) => {
    if (!allowedContext() || Date.now() < read.getState().retryAt || !coordinator.enter()) return null;
    const ticket = generation.current; setError(null); setNotice(null);
    try { const next = readBootPreference(await action()); if (!next) throw new Error("invalid-preference"); if (!mounted.current || ticket !== generation.current) return null; read.setData(() => next); return next; }
    catch (failure) {
      coordinator.failure(failure);
      if (mounted.current && ticket === generation.current) {
        setError(messageOf(failure));
        if (failure instanceof ProviderError && failure.ambiguous) { uncertainRef.current = true; setUncertain(true); }
        if (failure instanceof ProviderError && failure.status === 409) {
          recoveryRef.current = true; setRecoveryRequired(true); invalidateConfirmation(value => value + 1);
          setError("La preferencia cambió en otro cliente. La confirmación anterior quedó invalidada. Revisa la preferencia actual antes de confirmar otra vez.");
          // Solo GET local; useRead y el coordinador conservan Retry-After. No repite la mutación.
          read.refresh();
        }
        if (failure instanceof ProviderError && failure.status === 401) expire();
      }
      return null;
    } finally { coordinator.leave(); }
  }, [allowedContext, coordinator, read.getState, read.setData, read.refresh, expire]);
  const set = useCallback(async (system: BootSystem) => {
    const preference = read.getState().data;
    if (recoveryRef.current) return false;
    if (!preference || uncertainRef.current || ["pending", "applying", "uncertain", "drift"].includes(preference.state)) { if (mounted.current) setError("Comprueba o cancela la preferencia pendiente antes de pedir otro cambio."); return false; }
    if (!allowedContext() || coordinator.blocker()) return false;
    const result = await run(() => provider.setBootPreference(system, preference.version, newIdempotencyKey())); const applied = result?.state === "applied" && result.effective === system;
    if (mounted.current && !recoveryRef.current) setNotice(applied ? `Listo: ${SYSTEM_NAME[system]} es ahora el predeterminado.` : result ? result.message ?? "El nuevo predeterminado aún no está verificado. No se envió ninguna orden de energía." : null);
    return applied && !recoveryRef.current && allowedContext();
  }, [read.getState, allowedContext, coordinator, run]);
  const cancel = useCallback(async () => { const preference = read.getState().data; if (!preference || preference.state !== "pending" || recoveryRef.current || uncertainRef.current || !allowedContext() || coordinator.blocker()) return; await run(() => provider.cancelBootPreference(preference.version)); }, [read.getState, allowedContext, coordinator, run]);
  const recover = useCallback(async () => {
    if (!allowedContext() || coordinator.blocker() || read.getState().loading) return;
    const result = await run(() => provider.getBootPreference());
    if (result && mounted.current && allowedContext()) { recoveryRef.current = false; setRecoveryRequired(false); setError(null); setNotice("Preferencia actualizada. Revisa el sistema y confirma de nuevo; no se envió energía."); }
  }, [allowedContext, coordinator, read.getState, run]);
  const verify = useCallback(async () => { if (recoveryRef.current) { await recover(); return; } if (!allowedContext() || coordinator.blocker()) return; const result = await run(() => provider.verifyBootPreference()); if (result && mounted.current) { uncertainRef.current = false; setUncertain(false); } }, [allowedContext, coordinator, run, recover]);
  const clearMessages = useCallback(() => { if (recoveryRef.current) return; setError(null); setNotice(null); }, []);
  // El backoff de GET de preferencias no revoca acciones de energía independientes.
  const blocker = !online ? "Sin conexión. No puedes cambiar ni comprobar el arranque." : !visible ? "Vuelve a la app para continuar." : coordinator.blocker();
  return { preference: read.data, working: coordinator.working, error: error ?? (read.error ? "No se pudo leer la preferencia de arranque." : uncertain ? "Respuesta sin confirmar. Comprueba el firmware antes de otro cambio." : null), notice, blocker, retryAt: Math.max(coordinator.retryAt, read.retryAt), recoveryRequired, confirmationRevision, recover, set, cancel, verify, clearMessages };
}
export function BootDefaultRow({ boot, chosen, onRequestSet }: { boot: BootDefaultState; chosen: BootSystem; onRequestSet: (system: BootSystem) => void }) {
  const view = bootRowView(boot.preference, chosen);
  const action = boot.recoveryRequired ? { kind: "recover" as const, label: "Revisar preferencia actual" } : boot.error ? { kind: "verify" as const, label: "Comprobar" } : view?.action;
  if (!view && !boot.error && !boot.blocker) return null;
  return <div className="boot-default" role="group" aria-label="Sistema predeterminado"><p className="boot-default__text t-small" role="status" aria-live="polite">{boot.blocker ?? boot.error ?? (boot.notice && !action ? boot.notice : view?.text)}</p>{action && <Key variant="cream" size="sm" loading={boot.working} disabled={boot.blocker !== null || Date.now() < boot.retryAt} onClick={() => { if (boot.blocker) return; if (action.kind === "recover") void boot.recover(); else if (action.kind === "set") onRequestSet(action.system); else if (action.kind === "cancel") void boot.cancel(); else void boot.verify(); }}>{action.label}</Key>}</div>;
}
