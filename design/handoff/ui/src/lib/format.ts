const clockFormat = new Intl.DateTimeFormat("es", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const clockShortFormat = new Intl.DateTimeFormat("es", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayFormat = new Intl.DateTimeFormat("es", {
  day: "numeric",
  month: "short",
});
const moneyFormat = new Intl.NumberFormat("es", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** "hace 40 s". `null` => el proveedor nunca observó el recurso. */
export function formatAgo(iso: string | null, nowMs: number): string {
  if (iso === null) return "sin observación";
  const elapsed = Math.max(0, nowMs - Date.parse(iso));
  if (elapsed < MINUTE) return `hace ${Math.floor(elapsed / SECOND)} s`;
  if (elapsed < HOUR) return `hace ${Math.floor(elapsed / MINUTE)} min`;
  return `hace ${Math.floor(elapsed / HOUR)} h`;
}

export function formatClock(iso: string): string {
  return clockFormat.format(new Date(iso));
}

export function formatClockShort(iso: string): string {
  return clockShortFormat.format(new Date(iso));
}

export function formatDay(iso: string): string {
  return dayFormat.format(new Date(iso));
}

/** US$ 18,40 · US$ −8,00 · — (null NUNCA se convierte en cero). Solo redondea para mostrar. */
export function formatUsd(amount: number | null): string {
  if (amount === null) return "—";
  const text = moneyFormat.format(Math.abs(amount));
  return `${amount < 0 ? "−" : ""}US$ ${text}`;
}

/** 900 => "15:00". */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Ratio 0..1 del presupuesto gastado; null si falta límite o gasto. */
export function budgetRatio(
  actual: number | null,
  limit: number | null,
): number | null {
  if (actual === null || limit === null || limit <= 0) return null;
  return actual / limit;
}
