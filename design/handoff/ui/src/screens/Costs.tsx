import { useEffect } from "react";
import { useAppState } from "../app/AppState.tsx";
import { summarizeCosts } from "../lib/costs.ts";
import {
  budgetRatio,
  formatUsd,
  formatDay,
  formatClockShort,
} from "../lib/format.ts";
import { Panel } from "../components/Panel.tsx";
import { Banner } from "../components/Banner.tsx";
import { Disclosure } from "../components/Fields.tsx";
import { CoinSprite } from "../components/Sprites.tsx";
import { Pill } from "../components/Pill.tsx";
import { Key } from "../components/Key.tsx";
export function Costs() {
  const app = useAppState();
  useEffect(() => {
    app.enableCosts(true);
  }, [app.enableCosts]);
  const report = app.costs.data;
  const total = summarizeCosts(report?.accounts ?? []);
  return (
    <div className="page stack gap-26">
      <header>
        <p className="t-label">
          AWS · {report?.accounts.length ?? "…"} CUENTAS
        </p>
        <h1 className="t-h1 mt-8">Costes</h1>
        <p className="t-small mt-12">
          {report
            ? `${formatDay(report.periodStart)} — ${formatDay(report.periodEnd)} · período UTC`
            : "Primer cálculo en curso"}
        </p>
        <p className="t-caption mt-8">
          {report
            ? `Consultado ${formatDay(report.fetchedAt)} ${formatClockShort(report.fetchedAt)} · caché de 24 h`
            : "Puede tardar. No se fuerzan consultas adicionales a AWS."}
        </p>
      </header>
      {!report ? (
        <Panel tone="night">
          <div className="empty">
            <CoinSprite size={64} />
            <h2 className="t-h3">
              {app.costs.error
                ? "No pudimos consultar los costes"
                : "Calculando el informe…"}
            </h2>
            <p>
              No cierres una espera para forzar otra consulta. Los valores
              ausentes no son cero.
            </p>
            {app.costs.error ? (
              <Key
                variant="cream"
                disabled={app.now < app.costs.retryAt}
                onClick={app.costs.refresh}
              >
                Consultar cuando termine la espera
              </Key>
            ) : (
              <div className="skeleton" style={{ width: "80%", height: 32 }} />
            )}
          </div>
        </Panel>
      ) : (
        <>
          <Panel tone="night" accent="coral">
            <div className="row-flex gap-14">
              <CoinSprite size={48} />
              <div>
                <p className="t-label">
                  {total.complete
                    ? "NETO ESTIMADO"
                    : `SUBTOTAL · ${total.count} CUENTAS COMPLETAS`}
                </p>
                <p className="t-h1 mt-12">{formatUsd(total.net)}</p>
              </div>
            </div>
            <p className="t-small mt-18">
              Incluye créditos y reembolsos. Neto cero no equivale a
              infraestructura gratis.
            </p>
            <div className="line mt-16">
              <span>Consumo y otros cargos</span>
              <span className="t-mono">{formatUsd(total.usage)}</span>
            </div>
            <div className="line">
              <span>Créditos y reembolsos</span>
              <span className="t-mono">{formatUsd(total.adjustments)}</span>
            </div>
            {!total.complete && (
              <p className="t-small mt-14">
                Las cuentas parciales, sin datos o en otra moneda no entran en
                este subtotal.
              </p>
            )}
          </Panel>
          {report.accounts.map((a) => (
            <Panel key={a.account} tone="paper" accent="violet">
              <div className="row-flex wrap gap-12">
                <h2 className="t-h3 grow">{a.account}</h2>
                <Pill
                  tone={
                    a.status === "available"
                      ? "on"
                      : a.status === "partial"
                        ? "warn"
                        : "unk"
                  }
                  glyph={a.status === "available" ? "check" : "bang"}
                >
                  {a.status === "available"
                    ? "Disponible"
                    : a.status === "partial"
                      ? "Parcial"
                      : "Sin permiso / sin datos"}
                </Pill>
              </div>
              <p className="t-label mt-22">
                NETO {a.estimated ? "ESTIMADO" : ""}
              </p>
              <p className="t-title mt-8">
                {a.currency === "USD"
                  ? formatUsd(a.net)
                  : a.net === null
                    ? "—"
                    : `${a.currency} ${a.net.toFixed(2)}`}
              </p>
              <div className="line mt-16">
                <span>Consumo y otros cargos</span>
                <span className="t-mono">
                  {a.currency === "USD" ? formatUsd(a.usage) : "—"}
                </span>
              </div>
              <div className="line">
                <span>Créditos y reembolsos</span>
                <span className="t-mono">
                  {a.currency === "USD" ? formatUsd(a.adjustments) : "—"}
                </span>
              </div>
              {a.status === "partial" && (
                <Banner
                  className="mt-14"
                  tone="warn"
                  glyph="bang"
                  title="Lectura parcial"
                >
                  Se alcanzó el límite de páginas. Estos importes no se suman al
                  total.
                </Banner>
              )}
              <h3 className="t-label mt-22">PRESUPUESTOS</h3>
              {a.budgetsStatus === "unavailable" ? (
                <p className="t-small mt-12">
                  No se pudo consultar Budgets; no significa que no existan
                  presupuestos.
                </p>
              ) : a.budgets.length === 0 ? (
                <p className="t-small mt-12">
                  AWS no devolvió presupuestos de coste.
                </p>
              ) : (
                a.budgets.map((b) => {
                  const ratio = budgetRatio(b.actual, b.limit);
                  const money = (n: number | null) =>
                    b.currency === "USD"
                      ? formatUsd(n)
                      : n === null
                        ? "—"
                        : `${b.currency} ${n.toFixed(2)}`;
                  return (
                    <div className="mt-18" key={b.name}>
                      <div className="row-flex gap-12">
                        <strong className="grow">{b.name}</strong>
                        <span className="t-mono">
                          {ratio === null
                            ? "—"
                            : `${Math.round(ratio * 100)} %`}
                        </span>
                      </div>
                      <div
                        className="budget-bar mt-12"
                        role="img"
                        aria-label={
                          ratio === null
                            ? "Presupuesto sin datos"
                            : `${Math.round(ratio * 100)} por ciento del presupuesto`
                        }
                      >
                        {Array.from({ length: 10 }, (_, i) => (
                          <span
                            key={i}
                            className={
                              ratio !== null &&
                              i < Math.ceil(Math.max(0, ratio) * 10)
                                ? `is-on ${ratio >= 0.9 ? "is-hot" : ""}`
                                : ""
                            }
                          />
                        ))}
                      </div>
                      <p className="t-small mt-10">
                        {money(b.actual)} de {money(b.limit)}
                      </p>
                      <p className="t-caption mt-8">
                        {b.forecast === null
                          ? "Sin previsión de AWS"
                          : `Previsión ${money(b.forecast)}`}
                      </p>
                    </div>
                  );
                })
              )}
              <div className="mt-18">
                <Disclosure
                  summary={`Neto por servicio (${a.services.length})`}
                >
                  <p className="t-small mt-12">
                    Incluye créditos repartidos por servicio.
                  </p>
                  {a.services.map((s) => (
                    <div className="line" key={s.name}>
                      <span className="t-small t-wrap">{s.name}</span>
                      <span className="t-mono t-small">
                        {a.currency === "USD"
                          ? formatUsd(s.amount)
                          : `${a.currency} ${s.amount}`}
                      </span>
                    </div>
                  ))}
                </Disclosure>
              </div>
            </Panel>
          ))}
          <p className="t-small">{report.policy}</p>
          <p className="t-caption">
            Próxima actualización desde {formatDay(report.nextRefreshAt)}{" "}
            {formatClockShort(report.nextRefreshAt)}. No se fuerza desde la app.
          </p>
        </>
      )}
    </div>
  );
}
