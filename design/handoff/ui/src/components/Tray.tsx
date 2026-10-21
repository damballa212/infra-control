import { useAppState } from "../app/AppState.tsx";
import { isActiveOperation, describeOperation } from "../lib/status.ts";
import { Link } from "../lib/router.tsx";
export function Tray() {
  const app = useAppState();
  const operation = app.operations.data?.operations.find(isActiveOperation);
  if (!operation) return null;
  return (
    <aside className="tray" aria-label="Orden pendiente">
      <Link
        className="tray__button"
        to={{ name: "operation", id: operation.id }}
      >
        <span className="order-band is-active" />
        <span className="tray__text">
          <strong className="tray__title">{operation.resourceName}</strong>
          <span className="t-small">
            {describeOperation(operation.state).label} · Ver orden ▸
          </span>
        </span>
      </Link>
    </aside>
  );
}
