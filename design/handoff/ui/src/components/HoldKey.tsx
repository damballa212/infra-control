import { useEffect, useRef, useState, type ReactNode } from "react";

export interface HoldKeyProps {
  children: ReactNode;
  /** Duración del gesto; el borrado accidental cuesta más en equipos que dan servicio a otras personas. */
  holdMs?: number;
  busy?: boolean;
  onConfirm: () => void;
  describedBy?: string;
}

/** Confirmación por mantener pulsado. Con teclado o lector de pantalla basta Enter/Espacio (sin gesto largo). */
export function HoldKey({
  children,
  holdMs = 1000,
  busy = false,
  onConfirm,
  describedBy,
}: HoldKeyProps) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(() => stop, []);
  const start = () => {
    if (busy || timer.current !== null) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHolding(false);
      if (typeof navigator.vibrate === "function") navigator.vibrate(15);
      confirmRef.current();
    }, holdMs);
  };
  return (
    <button
      type="button"
      className={`key key--lg key--red hold-key ${holding ? "is-holding" : ""}`}
      style={{ ["--hold-ms" as string]: `${holdMs}ms` }}
      disabled={busy}
      aria-describedby={describedBy}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        // detail === 0: activación por teclado o lector de pantalla.
        if (event.detail === 0 && !busy) confirmRef.current();
      }}
    >
      <span className="hold-key__fill" aria-hidden="true" />
      <span className="hold-key__label">{children}</span>
    </button>
  );
}
