import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BootDefaultRow, useBootDefault } from "./BootDefault.tsx";
import { SYSTEM_NAME } from "../lib/bootDefault.ts";
import { createPortal } from "react-dom";
import { Glyph } from "./Glyph.tsx";
import { Hermes } from "./Hermes.tsx";
import { Key } from "./Key.tsx";
import { HoldKey } from "./HoldKey.tsx";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Foco contenido en el diálogo; Esc cancela; al cerrar se restaura el foco; el resto de la app queda inerte. */
function useDialogBehavior(onCancel: () => void) {
  const container = useRef<HTMLElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const appRoot = document.getElementById("root");
    if (appRoot) appRoot.inert = true;
    cancelButton.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab" || container.current === null) return;
      const items = Array.from(
        container.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (appRoot) appRoot.inert = false;
      opener?.focus();
    };
  }, []);

  return { container, cancelButton };
}

export interface ConfirmPowerDialogProps {
  title: string;
  lines: readonly string[];
  confirmLabel: string;
  /** Hermes dormido junto al título (solo cuando la orden apaga a Hermes). */
  showSleepingHermes: boolean;
  busy?: boolean;
  /** Apagar: exige mantener pulsado (más tiempo si el equipo da servicio a otras personas). */
  holdMs?: number;
  /** Contenido opcional entre la lista y las acciones (p. ej. la elección del sistema del próximo encendido). */
  extra?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPowerDialog({
  title,
  lines,
  confirmLabel,
  showSleepingHermes,
  busy = false,
  holdMs,
  extra,
  onConfirm,
  onCancel,
}: ConfirmPowerDialogProps) {
  const titleId = useId();
  const holdHelp = useId();
  const bodyId = useId();
  const { container, cancelButton } = useDialogBehavior(onCancel);

  return createPortal(
    <>
      <div className="scrim" aria-hidden="true" />
      <section
        ref={(node) => {
          container.current = node;
        }}
        className="dialog on-night anim-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <div className="row-flex gap-12">
          {showSleepingHermes ? (
            <span
              aria-hidden="true"
              className="row-flex"
              style={{
                width: 64,
                height: 64,
                flex: "none",
                justifyContent: "center",
                background: "var(--color-surface-night-raised)",
              }}
            >
              <Hermes mood="asleep" size={56} />
            </span>
          ) : null}
          <div className="grow">
            <p className="dialog__eyebrow">ORDEN DE ENERGÍA</p>
            <h2
              id={titleId}
              className="t-h3 t-wrap anim-type mt-8"
              style={{
                fontSize: "var(--font-size-h2)",
                animationDelay: "120ms",
              }}
            >
              {title}
            </h2>
          </div>
        </div>
        <ul id={bodyId} className="dialog__lines stack gap-8 mt-14">
          {lines.map((line, index) => (
            <li
              key={line}
              className="anim-type"
              style={{ animationDelay: `${260 + index * 120}ms` }}
            >
              <Glyph name="arrowRight" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        {extra}
        <div
          className="dialog__actions anim-enter"
          style={{ animationDelay: "560ms" }}
        >
          {holdMs ? (
            <>
              <HoldKey
                holdMs={holdMs}
                busy={busy}
                onConfirm={onConfirm}
                describedBy={holdHelp}
              >
                Mantén pulsado: {confirmLabel.replace("Sí, ", "")}
              </HoldKey>
              <p id={holdHelp} className="t-small hold-help">
                Suelta antes de que se llene para cancelar. Con teclado o lector de pantalla, Enter confirma.
              </p>
            </>
          ) : (
            <Key
              variant="red"
              size="lg"
              onClick={onConfirm}
              loading={busy}
              disabled={busy}
            >
              {confirmLabel}
            </Key>
          )}
          <button
            ref={cancelButton}
            type="button"
            className="key key--lg key--cream"
            onClick={onCancel}
          >
            Cancelar
          </button>
        </div>
      </section>
    </>,
    document.body,
  );
}

export type { ReactNode };

export function SystemPickerDialog({ current, running, actions, busy, onCancel, onChoose }: {
  current?: "windows" | "cachyos"; running:boolean; actions:readonly string[]; busy:boolean;
  onCancel:()=>void; onChoose:(system:"windows"|"cachyos")=>void;
}) {
  const [chosen, choose] = useState<"windows"|"cachyos">(current ?? "cachyos");
  const [confirming, setConfirming] = useState<"windows"|"cachyos"|null>(null);
  const boot = useBootDefault();
  const {container,cancelButton}=useDialogBehavior(onCancel);
  const titleId=useId(); const name=chosen==="windows"?"Windows":"CachyOS";
  const allowed=actions.includes(chosen==="windows"?"boot-windows":"boot-cachyos");
  const effective=boot.preference?.effective??null;
  if (confirming) {
    const target=SYSTEM_NAME[confirming];
    return createPortal(<><div className="scrim" aria-hidden="true"/><section ref={node=>{container.current=node;}} className="dialog on-night" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 className="t-h2" id={titleId}>¿{target} como predeterminado?</h2>
      <p className="t-small mt-22">La PC arrancará con {target} cuando se encienda sola, por ejemplo tras un corte de luz o un encendido remoto. No se reinicia ahora y no cambia lo que elijas al encender.</p>
      {boot.error&&<p className="t-small boot-default__error mt-12" role="alert">{boot.error}</p>}
      <div className="key-pair mt-22"><span ref={node=>{cancelButton.current=node?.querySelector("button")??null;}}><Key variant="cream" disabled={boot.working} onClick={()=>{boot.clearMessages();setConfirming(null);}}>Volver</Key></span><Key variant="sunOnNight" loading={boot.working} disabled={boot.working} onClick={()=>void boot.set(confirming).then(ok=>{if(ok)setConfirming(null);})}>Sí, cambiar</Key></div>
    </section></>,document.body);
  }
  return createPortal(<><div className="scrim" aria-hidden="true"/><section ref={node=>{container.current=node;}} className="dialog on-night" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
    <h2 className="t-h2" id={titleId}>Elige el sistema</h2>
    <div className="system-options mt-22">
      {(["cachyos","windows"] as const).map(system=><Key key={system} variant={chosen===system?"sunOnNight":"cream"} aria-pressed={chosen===system} aria-label={effective===system?`${SYSTEM_NAME[system]}, predeterminado`:undefined} onClick={()=>{boot.clearMessages();choose(system);}}><span>{SYSTEM_NAME[system]}{effective===system?" ★":""}</span>{running&&current===system&&<small className="system-options__now">Actual</small>}</Key>)}
    </div>
    <BootDefaultRow boot={boot} chosen={chosen} onRequestSet={system=>{boot.clearMessages();setConfirming(system);}}/>
    <p className="t-small mt-22">{running?(chosen===current?"Reinicia la PC en el mismo sistema. Guarda tu trabajo antes de continuar.":"El cambio reinicia la PC. Guarda tu trabajo antes de continuar."):"La PC encenderá y preparará el sistema elegido."}</p>
    <div className="key-pair mt-22"><span ref={node=>{cancelButton.current=node?.querySelector("button")??null;}}><Key variant="cream" onClick={onCancel}>Cancelar</Key></span><Key variant="sunOnNight" disabled={!allowed||busy} onClick={()=>onChoose(chosen)}>{running?`Reiniciar en ${name}`:`Encender en ${name}`}</Key></div>
  </section></>,document.body);
}
