import type { Resource } from "../contract.ts";
import { StateChip } from "./Pill.tsx";
import { describeResourceState, displayName } from "../lib/status.ts";
import { formatAgo } from "../lib/format.ts";

/** Pasado este tiempo la lectura deja de ser reciente y se muestra su antigüedad. */
const STALE_MS = 3 * 60 * 1000;

/** Subtítulo de la fila: el estado, y la antigüedad solo cuando la lectura ya no es reciente. */
function subtitle(resource: Resource, now: number): string {
  const view = describeResourceState(resource);
  const parts: string[] = [view.label];
  if (view.hint && view.tone !== "on") parts.push(view.hint);
  if (resource.observedAt !== null && now - Date.parse(resource.observedAt) > STALE_MS)
    parts.push(`lectura ${formatAgo(resource.observedAt, now).replace("hace ", "de hace ")}`);
  return parts.join(" · ");
}
import { Link } from "../lib/router.tsx";
export function ResourceRow({
  resource,
  now,
  onSelect,
}: {
  resource: Resource;
  now: number;
  onSelect?: (resource: Resource) => void;
}) {
  const body = (
    <>
      <StateChip resource={resource} />
      <span className="grow stack" style={{ gap: 3 }}>
        <span className="list-row__title">{displayName(resource)}</span>
        <span className="t-caption">{subtitle(resource, now)}</span>
      </span>
      <span aria-hidden="true">▸</span>
    </>
  );
  return onSelect ? (
    <button className="list-row" onClick={() => onSelect(resource)}>
      {body}
    </button>
  ) : (
    <Link className="list-row" to={{ name: "resource", id: resource.id }}>
      {body}
    </Link>
  );
}
