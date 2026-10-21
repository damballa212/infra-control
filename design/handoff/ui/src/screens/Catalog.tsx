import { listScenarios } from "../../../states/scenarios.ts";
import { BackKey } from "../components/Key.tsx";
import { Panel } from "../components/Panel.tsx";
export function Catalog() {
  return (
    <div className="page stack gap-26">
      <BackKey to="/">Control</BackKey>
      <h1 className="t-h1">Catálogo de estados</h1>
      <p>Escenarios locales de prototipo. No ejecutan órdenes reales.</p>
      <Panel tone="paper" flush>
        {listScenarios().map((s) => (
          <a
            key={s.id}
            className="list-row"
            href={`/${s.id.startsWith("login") ? "acceso" : s.id.startsWith("costs") ? "costes" : s.id.startsWith("password") ? "ajustes/contrasena" : s.id.startsWith("activity") || s.id.startsWith("ops") ? "actividad" : ""}?s=${s.id}`}
          >
            <span className="stack gap-8">
              <strong>{s.id}</strong>
              <span className="t-small">{s.description}</span>
            </span>
          </a>
        ))}
      </Panel>
    </div>
  );
}
