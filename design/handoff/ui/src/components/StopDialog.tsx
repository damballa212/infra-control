import { useState } from "react";
import type { BootSystem } from "../contract.ts";
import { SYSTEM_NAME } from "../lib/bootDefault.ts";
import { ConfirmPowerDialog } from "./Dialog.tsx";
import { Key } from "./Key.tsx";
import { useBootDefault } from "./BootDefault.tsx";

/**
 * Apagar la PC. Si el panel tiene el sistema predeterminado verificado, deja elegir con cuál arrancará la próxima vez:
 * así el siguiente encendido (incluido WOL) entra directo, sin arrancar uno y reiniciar a otro. Si no hay lectura
 * verificada el diálogo es el de siempre. La elección solo cambia el predeterminado; nunca reinicia.
 */
export function StopDialog({
  busy,
  onStop,
  onCancel,
}: {
  busy: boolean;
  onStop: () => void;
  onCancel: () => void;
}) {
  const boot = useBootDefault();
  const [next, setNext] = useState<BootSystem | null>(null);
  const preference = boot.preference;
  const effective = preference?.effective ?? null;
  const settled =
    preference !== null &&
    effective !== null &&
    (preference.state === "applied" ||
      preference.state === "unknown" ||
      preference.state === "failed");
  const selected = next ?? effective;
  const changing = settled && selected !== null && selected !== effective;

  const confirm = async () => {
    if (changing && selected) {
      const ok = await boot.set(selected);
      if (!ok) return;
    }
    onStop();
  };

  const extra = settled && selected ? (
    <div className="boot-choice" role="group" aria-label="Sistema del próximo encendido">
      <p className="t-small boot-choice__label">Al volver a encender arrancará con:</p>
      <div className="system-options">
        {(["cachyos", "windows"] as const).map((system) => (
          <Key
            key={system}
            variant={selected === system ? "sunOnNight" : "cream"}
            size="sm"
            aria-pressed={selected === system}
            disabled={busy || boot.working}
            onClick={() => {
              boot.clearMessages();
              setNext(system);
            }}
          >
            {SYSTEM_NAME[system]}
          </Key>
        ))}
      </div>
      <p
        className={boot.error ? "t-small boot-default__error" : "t-small boot-choice__note"}
        role={boot.error ? "alert" : "status"}
      >
        {boot.error ??
          (changing && selected
            ? `Se cambiará el predeterminado a ${SYSTEM_NAME[selected]} antes de apagar.`
            : `${SYSTEM_NAME[selected]} sigue como predeterminado.`)}
      </p>
    </div>
  ) : null;

  return (
    <ConfirmPowerDialog
      title="¿Apagar la PC?"
      lines={["Guarda tu trabajo: se cerrarán las sesiones de la PC."]}
      confirmLabel="Sí, apagar"
      showSleepingHermes={false}
      busy={busy || boot.working}
      holdMs={1000}
      extra={extra}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    />
  );
}
