import type { Operation, Resource } from "../contract.ts";
import type { HermesMood } from "../components/Hermes.tsx";
export function hermesMood(
  resource: Pick<Resource, "state">,
  operation?: Pick<Operation, "state">,
): HermesMood {
  if (operation?.state === "uncertain" || operation?.state === "failed")
    return "unsure";
  if (operation?.state === "accepted" || operation?.state === "running")
    return "busy";
  if (resource.state === "stopped") return "asleep";
  if (resource.state === "pending" || resource.state === "stopping")
    return "busy";
  return resource.state === "running" ? "awake" : "unsure";
}
