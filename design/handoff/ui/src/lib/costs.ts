import type { CostAccount } from "../contract.ts";
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
