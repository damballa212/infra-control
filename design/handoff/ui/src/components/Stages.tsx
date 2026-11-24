import type { OperationState } from "../contract.ts";
import { operationView } from "../lib/controlModel.ts";
import { orderTone } from "../lib/activityModel.ts";

/** Registrada → En curso → Resultado como tres barras (mismo gesto que la tarjeta de la PC en Hoy). */
export function OrderStages({ state }: { state: OperationState }) {
  const view = operationView(state);
  const tone = orderTone(state);
  const bar = (index: number) => index < view.stage ? "is-done" : index === view.stage ? view.final ? `is-final is-${tone}` : "is-now" : "";
  return <div className={`act-steps act-steps--${tone}`} role="img" aria-label={`Etapas de la orden: ${view.final ? `resultado ${view.label.toLocaleLowerCase("es")}` : view.label.toLocaleLowerCase("es")}`}>
    <div className="act-steps__bars" aria-hidden="true">{[1, 2, 3].map(index => <span key={index} className={bar(index)} />)}</div>
    <div className="act-steps__labels" aria-hidden="true"><span>Registrada</span><span>En curso</span><span>{view.final ? view.label : "Resultado"}</span></div>
  </div>;
}
