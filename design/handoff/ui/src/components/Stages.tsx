import type { OperationState } from "../contract.ts";
import { describeOperation } from "../lib/status.ts";

function blockClass(index: 1 | 2 | 3, state: OperationState): string {
  const view = describeOperation(state);
  if (index < view.stage) return "is-done";
  if (index === view.stage && !view.final) return "is-active";
  if (index === 3 && view.final)
    return state === "succeeded"
      ? "is-ok"
      : state === "uncertain"
        ? "is-unc"
        : "is-bad";
  return "";
}

/** Registrada → En curso → Resultado. No hay porcentaje: el backend no lo publica. */
export function OrderStages({ state }: { state: OperationState }) {
  const view = describeOperation(state);
  const blocks: ReadonlyArray<1 | 2 | 3> = [1, 2, 3];
  return (
    <div aria-hidden="true">
      <div className="stages">
        {blocks.map((index) => (
          <span
            key={index}
            className={`stage-block ${blockClass(index, state)}`}
          />
        ))}
      </div>
      <div className="stage-labels">
        <span>Registrada</span>
        <span>En curso</span>
        <span>{view.final ? view.label : "Resultado"}</span>
      </div>
    </div>
  );
}
