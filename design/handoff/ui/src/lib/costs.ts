import type { CostAccount } from "../contract.ts";
import { budgetRatio } from "./format.ts";

/** Solo suman cuentas completas en USD con neto disponible; lo ausente nunca se convierte en cero. */
export function summarizeCosts(accounts: CostAccount[]) {
  const usable = accounts.filter(
    (a) => a.status === "available" && a.currency === "USD" && a.net !== null,
  );
  const sum = (field: "net" | "usage" | "adjustments"): number | null =>
    usable.length === 0 || usable.some((a) => a[field] === null)
      ? null
      : usable.reduce((total, a) => total + (a[field] ?? 0), 0);
  return {
    net: sum("net"),
    usage: sum("usage"),
    adjustments: sum("adjustments"),
    count: usable.length,
    complete: accounts.length > 0 && usable.length === accounts.length,
  };
}

/** Misma regla que el subtotal, por cuenta: si no entra, se dice por qué (y nunca se muestra como cero). */
export function accountStanding(a: CostAccount): { counted: boolean; note: string | null } {
  if (a.status === "unavailable") return { counted: false, note: "sin datos · no se suma" };
  if (a.status === "partial") return { counted: false, note: "parcial · no se suma" };
  if (a.currency !== "USD") return { counted: false, note: `${a.currency} · no se suma` };
  if (a.net === null) return { counted: false, note: "sin datos · no se suma" };
  return { counted: true, note: null };
}

export const accountKey = (a: Pick<CostAccount, "accountId" | "account">): string => a.accountId ?? a.account;

const MONTH_FMT = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });
/** Mes del período del informe (UTC, como AWS), p. ej. «noviembre». */
export function monthLabel(periodStart: string | null | undefined): string | null {
  if (!periodStart || !Number.isFinite(Date.parse(periodStart))) return null;
  return MONTH_FMT.format(new Date(periodStart));
}

/** Tiempo hasta un instante futuro: «en 23 h», «en 12 min»; «pendiente» si ya pasó. */
export function untilLabel(at: string | null | undefined, now: number): string | null {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const left = Date.parse(at) - now;
  if (left <= 0) return "pendiente";
  const minutes = Math.ceil(left / 60000);
  if (minutes < 60) return `en ${minutes} min`;
  const hours = Math.round(left / 3600000);
  return hours < 48 ? `en ${hours} h` : `en ${Math.round(hours / 24)} d`;
}

export interface ServiceSlice { name: string; amount: number }
/**
 * Desglose por servicio. Con una cuenta elegida, sus servicios tal cual; con «Todas», solo las cuentas que
 * suman (completas, USD, con neto), agregando por nombre. El resto pasa a «Otros».
 */
export function serviceBreakdown(accounts: readonly CostAccount[], max = 5): { rows: ServiceSlice[]; currency: string | null; partial: boolean } {
  const single = accounts.length === 1 ? accounts[0]! : null;
  const sources = single ? [single] : accounts.filter(a => accountStanding(a).counted);
  if (!sources.length) return { rows: [], currency: null, partial: false };
  const totals = new Map<string, number>();
  for (const account of sources) for (const service of account.services) if (Number.isFinite(service.amount)) totals.set(service.name, (totals.get(service.name) ?? 0) + service.amount);
  const sorted = [...totals.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const head = sorted.slice(0, max);
  const rest = sorted.slice(max);
  const rows = rest.length ? [...head, { name: "Otros", amount: rest.reduce((sum, row) => sum + row.amount, 0) }] : head;
  return { rows, currency: single ? single.currency : "USD", partial: !!single && !accountStanding(single).counted };
}

/** Lectura de un presupuesto: proporción gastada, previsión y si se pasa del límite. */
export function budgetView(b: CostAccount["budgets"][number]): { spent: number | null; forecast: number | null; over: number | null } {
  const spent = budgetRatio(b.actual, b.limit);
  const forecast = budgetRatio(b.forecast, b.limit);
  const over = b.forecast !== null && b.limit !== null && b.forecast > b.limit ? b.forecast - b.limit : null;
  return { spent, forecast, over };
}

export interface DailyBar { date: string; amount: number | null; height: number; partial: boolean }
/** Barras diarias: altura relativa al máximo, hueco para días sin dato y el día UTC en curso como parcial. */
export function dailyBars(days: readonly { date: string; amount: number | null }[], now: number): DailyBar[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const max = Math.max(0, ...days.flatMap(d => d.amount === null ? [] : [Math.abs(d.amount)]));
  return days.map(d => ({ date: d.date, amount: d.amount, partial: d.date === today, height: d.amount === null || max === 0 ? 0 : Math.max(3, Math.abs(d.amount) / max * 100) }));
}

const DAY_FMT = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", timeZone: "UTC" });
/** «1 nov» para una fecha AAAA-MM-DD del informe (UTC). */
export function shortDay(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? DAY_FMT.format(new Date(ms)).replace(".", "") : date;
}
