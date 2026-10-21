import type { BootPreference, BootSystem } from "../contract.ts";

export const SYSTEM_NAME: Readonly<Record<BootSystem, string>> = {
  windows: "Windows",
  cachyos: "CachyOS",
};

export type BootRowAction =
  | { kind: "set"; system: BootSystem; label: string }
  | { kind: "cancel"; label: string }
  | { kind: "verify"; label: string };

export interface BootRowView {
  text: string;
  action: BootRowAction | null;
}

/** La respuesta debe tener la forma del contrato; cualquier otra cosa (p. ej. `{}`) se trata como «no disponible». */
export function readBootPreference(value: unknown): BootPreference | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<BootPreference>;
  if (typeof candidate.state !== "string" || typeof candidate.version !== "number")
    return null;
  return candidate as BootPreference;
}

/**
 * Qué dice la fila del arranque predeterminado y qué se puede hacer. `chosen` es el sistema marcado en el selector.
 * Nunca afirma un valor que el firmware no haya verificado.
 */
export function bootRowView(
  preference: BootPreference | null,
  chosen: BootSystem,
): BootRowView | null {
  if (preference === null) return null;
  const { state, effective, desired } = preference;
  if (state === "applying")
    return { text: "Aplicando el cambio…", action: null };
  if (state === "pending" && desired)
    return {
      text: `Pendiente: ${SYSTEM_NAME[desired]}. Se aplica cuando la PC avise.`,
      action: { kind: "cancel", label: "Cancelar" },
    };
  if (state === "uncertain" || state === "drift")
    return {
      text:
        state === "drift"
          ? "El firmware no coincide con lo pedido."
          : "No se confirmó el último cambio.",
      action: { kind: "verify", label: "Comprobar" },
    };
  if (effective === null)
    return {
      text: "Predeterminado sin verificar.",
      action: { kind: "verify", label: "Comprobar" },
    };
  return chosen === effective
    ? { text: `★ ${SYSTEM_NAME[effective]} arranca solo.`, action: null }
    : {
        text: `★ Predeterminado: ${SYSTEM_NAME[effective]}.`,
        action: {
          kind: "set",
          system: chosen,
          label: "Hacer predeterminado",
        },
      };
}
