import { useCallback, useEffect, useRef, useState } from "react";
import type { BootPreference, BootSystem } from "../contract.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { provider } from "../app/providers.ts";
import { newIdempotencyKey } from "../lib/idempotency.ts";
import {
  SYSTEM_NAME,
  bootRowView,
  readBootPreference,
} from "../lib/bootDefault.ts";
import { Key } from "./Key.tsx";

export interface BootDefaultState {
  preference: BootPreference | null;
  working: boolean;
  error: string | null;
  notice: string | null;
  set: (system: BootSystem) => Promise<boolean>;
  cancel: () => Promise<void>;
  verify: () => Promise<void>;
  clearMessages: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof ProviderError)
    return error.ambiguous
      ? "No se confirmó la respuesta. Comprueba el estado antes de repetir."
      : error.message;
  return "No se pudo completar la solicitud.";
}

/** Lee la preferencia (SQLite del panel, sin consultar a la PC) y expone las tres acciones. */
export function useBootDefault(): BootDefaultState {
  const [preference, setPreference] = useState<BootPreference | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Una clave por intención: solo se reutiliza para recuperar el MISMO envío (mismo sistema y misma versión).
  const intent = useRef<{ system: BootSystem; version: number; key: string } | null>(null);

  useEffect(() => {
    let alive = true;
    provider
      .getBootPreference()
      .then((value) => alive && setPreference(readBootPreference(value)))
      .catch(() => alive && setPreference(null));
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async (action: () => Promise<BootPreference>) => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const next = readBootPreference(await action());
      if (next) setPreference(next);
      return next;
    } catch (failure) {
      setError(messageOf(failure));
      // Tras un fallo se vuelve a leer la versión actual (lectura local) para no actuar sobre datos viejos.
      void provider.getBootPreference().then((value) => setPreference(readBootPreference(value))).catch(() => undefined);
      return null;
    } finally {
      setWorking(false);
    }
  }, []);

  const set = useCallback(
    async (system: BootSystem) => {
      if (!preference || working) return false;
      const same =
        intent.current?.system === system && intent.current.version === preference.version;
      const key = same && intent.current ? intent.current.key : newIdempotencyKey();
      intent.current = { system, version: preference.version, key };
      const result = await run(() =>
        provider.setBootPreference(system, preference.version, key),
      );
      if (result?.state === "applied") {
        intent.current = null;
        setNotice(`Listo: ${SYSTEM_NAME[system]} es ahora el predeterminado.`);
        return true;
      }
      if (result) setNotice(result.message ?? null);
      return result !== null;
    },
    [preference, working, run],
  );

  const cancel = useCallback(async () => {
    if (!preference || working) return;
    await run(() => provider.cancelBootPreference(preference.version));
  }, [preference, working, run]);

  const verify = useCallback(async () => {
    if (working) return;
    await run(() => provider.verifyBootPreference());
  }, [working, run]);

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return { preference, working, error, notice, set, cancel, verify, clearMessages };
}

/** Fila compacta del selector de sistema: estado verificado a la izquierda y una sola acción a la derecha. */
export function BootDefaultRow({
  boot,
  chosen,
  onRequestSet,
}: {
  boot: BootDefaultState;
  chosen: BootSystem;
  onRequestSet: (system: BootSystem) => void;
}) {
  const view = bootRowView(boot.preference, chosen);
  if (view === null) return null;
  const { action } = view;
  const text = boot.notice && !action ? boot.notice : view.text;
  return (
    <div className="boot-default" role="group" aria-label="Sistema predeterminado">
      <p className="boot-default__text t-small" role="status" aria-live="polite">
        {boot.error ?? text}
      </p>
      {action && (
        <Key
          variant="cream"
          size="sm"
          loading={boot.working}
          disabled={boot.working}
          onClick={() => {
            if (action.kind === "set") onRequestSet(action.system);
            else if (action.kind === "cancel") void boot.cancel();
            else void boot.verify();
          }}
        >
          {action.label}
        </Key>
      )}
    </div>
  );
}
