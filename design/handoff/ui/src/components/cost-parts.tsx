import type { CostAccount } from "../contract.ts";
import { useAppState } from "../app/AppState.tsx";
import { age, dailyCosts, money } from "../lib/controlModel.ts";
import { accountKey, accountStanding, budgetView, dailyBars, serviceBreakdown, shortDay } from "../lib/costs.ts";
import { Card, Empty } from "./v2.tsx";

/** Piezas de Costes: tabla por cuenta, barras diarias, presupuestos y desglose por servicio. */

export function AccountTable({ accounts, selected }: { accounts: readonly CostAccount[]; selected: string }) {
  return <Card title="Por cuenta" flush className="cost-accounts">
    <table className="cost-table">
      <thead><tr><th scope="col">Cuenta</th><th scope="col" className="cost-num cost-wide">Uso</th><th scope="col" className="cost-num cost-wide">Créditos</th><th scope="col" className="cost-num">Neto</th></tr></thead>
      <tbody>{accounts.map((a, index) => {
        const standing = accountStanding(a);
        const noData = a.status === "unavailable" || (a.net === null && a.usage === null);
        const dim = selected !== "all" && selected !== accountKey(a);
        return <tr key={`${accountKey(a)}:${index}`} className={`${standing.counted ? "" : "is-out"}${dim ? " is-dim" : ""}`.trim() || undefined}>
          <th scope="row"><span className="cost-table__name">{a.account}</span><span className="cost-table__sub">{noData ? standing.note : `Uso ${money(a.usage, a.currency)} · créditos ${money(a.adjustments, a.currency)}${standing.note ? ` · ${standing.note}` : ""}`}</span></th>
          <td className="cost-num cost-wide">{noData ? <span className="cost-muted">sin datos</span> : money(a.usage, a.currency)}</td>
          <td className={`cost-num cost-wide${(a.adjustments ?? 0) < 0 ? " cost-credit" : ""}`}>{noData ? "—" : money(a.adjustments, a.currency)}</td>
          <td className="cost-num">{noData ? <span className="cost-muted">no se suma</span> : <>{money(a.net, a.currency)}{standing.note && <span className="cost-table__flag">{standing.note}</span>}</>}</td>
        </tr>;
      })}</tbody>
    </table>
  </Card>;
}

export function DailyChart({ accounts }: { accounts: readonly CostAccount[] }) {
  const app = useAppState();
  const bars = dailyBars(dailyCosts(accounts), app.now);
  const partial = bars.some(bar => bar.partial);
  const known = bars.filter(bar => bar.amount !== null);
  const peak = known.reduce<typeof known[number] | null>((best, bar) => best === null || Math.abs(bar.amount!) > Math.abs(best.amount!) ? bar : best, null);
  const last = bars.at(-1);
  return <Card title="Neto diario" meta={partial ? "hoy es parcial" : "USD · cuentas que suman"} className="cost-daily">
    {bars.length ? <>
      <div className="cost-bars" role="img" aria-label={`Neto diario de ${bars.length} días${peak ? `; máximo ${money(peak.amount, "USD")} el ${shortDay(peak.date)}` : ""}${last ? `; último ${money(last.amount, "USD")}` : ""}${partial ? "; hoy es parcial" : ""}`}>
        {bars.map(bar => <span key={bar.date} className={`cost-bar${bar.amount === null ? " is-missing" : ""}${bar.partial ? " is-partial" : ""}${bar === peak ? " is-peak" : ""}`}>
          {(bar === peak || bar === last) && bar.amount !== null && <span className="cost-bar__value">{money(bar.amount, "USD").replace("US$ ", "")}</span>}
          <span className="cost-bar__fill" style={{ height: `${bar.amount === null ? 100 : bar.height}%` }} />
        </span>)}
      </div>
      <div className="cost-bars__axis" aria-hidden="true"><span>{shortDay(bars[0]!.date)}</span>{bars.length > 2 && <span>{shortDay(bars[Math.floor(bars.length / 2)]!.date)}</span>}<span>{shortDay(bars.at(-1)!.date)}{partial ? " · parcial" : ""}</span></div>
    </> : <Empty title="Sin serie diaria que se pueda sumar." />}
  </Card>;
}

export function Budgets({ accounts }: { accounts: readonly CostAccount[] }) {
  const app = useAppState();
  const items = accounts.flatMap(a => a.budgets.map((b, i) => ({ a, b, key: `${accountKey(a)}:${b.name}:${i}` })));
  const missing = accounts.filter(a => a.budgetsStatus !== "available" || !a.budgets.length);
  const over = items.some(item => budgetView(item.b).over !== null);
  return <Card title="Presupuestos" meta={over ? undefined : items.length ? `${items.length}` : undefined} className={`cost-budgets${over ? " is-over" : ""}`}>
    {items.length > 0 && <ul className="cost-budget-list">{items.map(({ a, b, key }) => {
      const view = budgetView(b);
      return <li key={key} className={`cost-budget${view.over !== null ? " is-over" : ""}`}>
        <div className="cost-budget__head"><span className="cost-budget__name">{b.name}{!b.name.toLocaleLowerCase("es").includes(a.account.toLocaleLowerCase("es")) && <span className="cost-budget__acct">{a.account}</span>}</span><span className="cost-budget__fig">{view.over !== null || b.forecast !== null ? <><b>{money(b.forecast, b.currency)}</b> previsto</> : <><b>{money(b.actual, b.currency)}</b> gastado</>} de {money(b.limit, b.currency)}</span></div>
        <div className="cost-meter" role="img" aria-label={view.spent === null ? "Sin proporción disponible" : `${Math.round(view.spent * 100)} % gastado${view.forecast !== null ? `, ${Math.round(view.forecast * 100)} % previsto` : ""}`}>
          {view.forecast !== null && <span className="cost-meter__forecast" style={{ width: `${Math.min(100, Math.max(0, view.forecast * 100))}%` }} />}
          <span className="cost-meter__spent" style={{ width: `${view.spent === null ? 0 : Math.min(100, Math.max(0, view.spent * 100))}%` }} />
        </div>
        <p className="cost-budget__foot">{view.over !== null ? <span className="cost-warn">Se pasa {money(view.over, b.currency)} según la previsión de AWS</span> : <span>{money(b.actual, b.currency)} gastado{b.forecast === null ? " · sin previsión" : ""}</span>}<span className="t-age">{age(b.updatedAt, app.now)}</span></p>
      </li>;
    })}</ul>}
    {missing.length > 0 && <ul className="cost-budget-missing">{missing.map((a, i) => <li key={`${accountKey(a)}:${i}`}><span>{a.account}</span><span>{a.budgetsStatus === "unavailable" ? "sin datos de presupuestos" : a.budgetsStatus === "partial" ? "lista parcial" : "sin presupuestos en AWS"}</span></li>)}</ul>}
    {!items.length && !missing.length && <Empty title="Sin cuentas en el informe." />}
  </Card>;
}

export function Services({ accounts }: { accounts: readonly CostAccount[] }) {
  const { rows, currency, partial } = serviceBreakdown(accounts);
  const max = Math.max(0, ...rows.map(row => Math.abs(row.amount)));
  return <Card title="Por servicio" meta={partial ? "lectura parcial" : "neto"} className="cost-services">
    {rows.length && currency ? <ul className="cost-service-list">{rows.map(row => <li key={row.name} className="cost-service">
      <span className="cost-service__name" title={row.name}>{row.name}</span>
      <span className="cost-service__track" aria-hidden="true"><span style={{ width: `${max === 0 ? 0 : Math.max(2, Math.abs(row.amount) / max * 100)}%` }} className={row.amount < 0 ? "is-credit" : ""} /></span>
      <span className="cost-service__amount">{money(row.amount, currency)}</span>
    </li>)}</ul> : <Empty title="Sin desglose que se pueda sumar." />}
  </Card>;
}
