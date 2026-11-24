import { useEffect, useState } from "react";
import { useAppState } from "../app/AppState.tsx";
import { accountKey, monthLabel, summarizeCosts, untilLabel } from "../lib/costs.ts";
import { age, money } from "../lib/controlModel.ts";
import { Chip, Chips, Empty, Hint, ScreenHead, Skeleton, Stat } from "../components/v2.tsx";
import { AccountTable, Budgets, DailyChart, Services } from "../components/cost-parts.tsx";
import { ReadState } from "../components/act-ui.tsx";

export function Costs() {
  const app = useAppState();
  const [selected, setSelected] = useState("all");
  useEffect(() => { app.enableCosts(true); }, [app.enableCosts]);
  const report = app.costs.data;
  const all = report?.accounts ?? [];
  const total = summarizeCosts(all);
  const accounts = selected === "all" ? all : all.filter(a => accountKey(a) === selected);
  const month = monthLabel(report?.periodStart);
  const next = report ? untilLabel(report.nextRefreshAt, app.now) : null;

  return <div className="page cost">
    <ScreenHead title="Costes" avatar detail={!report && !app.costs.error ? "Primer cálculo en curso; puede tardar." : undefined} />
    {!report && (app.costs.error ? <div className="cost-read"><ReadState read={app.costs} what="los costes" /></div> : <div className="cost-read"><Skeleton rows={3} label="Calculando costes" /></div>)}
    {report && <>
      {app.costs.error && <div className="cost-read"><ReadState read={app.costs} what="los costes" /></div>}
      <section className="cost-hero" aria-label="Total del mes">
        <Stat label={total.complete ? `Neto estimado${month ? ` · ${month}` : ""}` : `Subtotal · ${total.count} de ${all.length} cuentas`} value={<span className="sc-cost-total">{money(total.net, "USD")}</span>} sub={total.usage !== null || total.adjustments !== null ? `Uso ${money(total.usage, "USD")} · créditos ${money(total.adjustments, "USD")}` : "Aún sin importes publicados"} />
        <p className="cost-hero__fresh"><span>datos {age(report.fetchedAt, app.now)}</span><span>próxima lectura {next ?? "sin fecha"} · no se fuerza</span></p>
      </section>
      {!total.complete && all.length > 0 && <Hint>Solo suman las cuentas completas en USD; las demás se muestran aparte.</Hint>}
      {!all.length ? <div className="v2-card cost-empty"><Empty title="El informe no trae cuentas visibles; no hay total." /></div> : <>
        {all.length > 1 && <div className="cost-pick"><Chips label="Cuenta para el desglose"><Chip pressed={selected === "all"} onClick={() => setSelected("all")}>Todas</Chip>{all.map((a, index) => <Chip key={`${accountKey(a)}:${index}`} pressed={selected === accountKey(a)} dot={a.status === "available" ? undefined : a.status === "partial" ? "stale" : "neutral"} onClick={() => setSelected(accountKey(a))}>{a.account}</Chip>)}</Chips></div>}
        <div className="v2-grid v2-grid--2 cost-grid">
          <div className="v2-stack">
            <AccountTable accounts={all} selected={selected} />
            <DailyChart accounts={accounts} />
          </div>
          <div className="v2-stack">
            <Budgets accounts={accounts} />
            <Services accounts={accounts} />
          </div>
        </div>
      </>}
    </>}
  </div>;
}
