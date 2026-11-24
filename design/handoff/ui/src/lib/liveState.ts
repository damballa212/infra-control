import type { DetailedResource, Operation, OperationsResponse, ResourcesSnapshotResponse } from "../contract.ts";
import { isActiveOperation } from "./status.ts";
export function eventSequence(value: string): number | null { if (!/^\d+$/.test(value)) return null; const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : null; }
function sameResource(a: DetailedResource, b: DetailedResource): boolean { return a.id === b.id || !!(a.catalog?.catalogId && b.catalog?.catalogId && a.catalog.catalogId === b.catalog.catalogId); }
function terminal(operation: Operation): boolean { return ["succeeded", "failed", "uncertain"].includes(operation.state); }
export function operationCanAdvance(previous: Operation, incoming: Operation): boolean {
  const before = Date.parse(previous.updatedAt); const after = Date.parse(incoming.updatedAt);
  if (Number.isFinite(before) && (!Number.isFinite(after) || after < before)) return false;
  if (terminal(previous) && !terminal(incoming)) return false;
  if (previous.state === "running" && incoming.state === "accepted") return false;
  if (terminal(previous) && terminal(incoming) && previous.state !== incoming.state && after <= before) return false;
  return true;
}
function newestReview(value: Operation, other: Operation): Operation {
  return other.review && (!value.review || other.review.version > value.review.version) ? { ...value, review: other.review } : value;
}
interface ResourceRow { value: DetailedResource; revision: number; event: number | null; unsequenced: boolean }
interface OperationRow { value: Operation; revision: number; event: number | null }
/** Por árbol autenticado. Cursor durable y revisiones locales no dependen de observedAt. */
export class LiveState {
  private revision = 0;
  private resources: ResourceRow[] = [];
  private operations = new Map<string, OperationRow>();
  private inventoryMeta: Omit<ResourcesSnapshotResponse, "resources"> | null = null;
  private operationsReady = false;
  private cursorValue = 0;
  // Incluye recursos omitidos: un evento anterior no puede resucitarlos.
  private inventoryWatermark = -1;
  begin(): number { return this.revision; }
  get cursor(): number { return this.cursorValue; }
  inventory(): ResourcesSnapshotResponse | null { return this.inventoryMeta ? { ...this.inventoryMeta, cursor: Math.max(this.inventoryMeta.cursor, this.cursorValue), resources: this.resources.map(row => row.value) } : null; }
  activity(): OperationsResponse | null { return this.operationsReady ? { operations: [...this.operations.values()].map(row => row.value).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) } : null; }
  acceptInventory(snapshot: ResourcesSnapshotResponse, started: number): ResourcesSnapshotResponse {
    const cursor = Number.isSafeInteger(snapshot.cursor) && snapshot.cursor >= 0 ? snapshot.cursor : 0;
    if (this.inventoryMeta && cursor < this.inventoryWatermark) return this.inventory()!;
    const pending = this.resources; const next: ResourceRow[] = [];
    for (const value of snapshot.resources) {
      const existing = pending.find(row => sameResource(row.value, value));
      const protectedRow = existing && (existing.unsequenced ? existing.revision > started : existing.event !== null && existing.event > cursor);
      next.push(protectedRow ? existing : { value, revision: ++this.revision, event: cursor, unsequenced: false });
    }
    for (const existing of pending) {
      if ((existing.unsequenced ? existing.revision > started : existing.event !== null && existing.event > cursor) && !next.some(row => sameResource(row.value, existing.value))) next.push(existing);
    }
    this.resources = next;
    this.inventoryWatermark = Math.max(this.inventoryWatermark, cursor);
    this.cursorValue = Math.max(this.cursorValue, cursor);
    this.inventoryMeta = { fetchedAt: snapshot.fetchedAt, refreshSeconds: snapshot.refreshSeconds, cursor };
    return this.inventory()!;
  }
  resourceEvent(value: DetailedResource, sequence: number | null): boolean {
    const existing = this.resources.find(row => sameResource(row.value, value));
    if (sequence !== null && (sequence <= this.inventoryWatermark || existing?.event !== null && existing?.event !== undefined && sequence <= existing.event)) return false;
    const row = { value, revision: ++this.revision, event: sequence ?? existing?.event ?? null, unsequenced: sequence === null };
    this.resources = [...this.resources.filter(item => !sameResource(item.value, value)), row];
    if (sequence !== null) this.cursorValue = Math.max(this.cursorValue, sequence);
    return true;
  }
  replaceInventory(snapshot: ResourcesSnapshotResponse): ResourcesSnapshotResponse {
    // Actualización local: no acredita un cursor de snapshot del servidor.
    this.inventoryMeta = { fetchedAt: snapshot.fetchedAt, refreshSeconds: snapshot.refreshSeconds, cursor: snapshot.cursor };
    this.resources = snapshot.resources.map(value => ({ value, revision: ++this.revision, event: this.resources.find(row => sameResource(row.value, value))?.event ?? null, unsequenced: true }));
    return this.inventory()!;
  }
  attach(value: Operation, sequence: number | null = null): boolean {
    const previous = this.operations.get(value.id);
    if (previous && (sequence !== null && previous.event !== null && sequence <= previous.event || !operationCanAdvance(previous.value, value))) {
      const merged = newestReview(previous.value, value);
      if (merged === previous.value) return false;
      this.operations.set(value.id, { ...previous, value: merged, revision: ++this.revision });
      return true;
    }
    this.operations.set(value.id, { value: previous ? newestReview(value, previous.value) : value, revision: ++this.revision, event: sequence ?? previous?.event ?? null });
    this.operationsReady = true;
    if (sequence !== null) this.cursorValue = Math.max(this.cursorValue, sequence);
    return true;
  }
  acceptOperationRead(value: Operation, started: number): Operation {
    const previous = this.operations.get(value.id);
    if (previous && previous.revision > started) {
      const merged = newestReview(previous.value, value);
      if (merged !== previous.value) this.operations.set(value.id, { ...previous, value: merged, revision: ++this.revision });
      return merged;
    }
    this.attach(value);
    return this.operations.get(value.id)!.value;
  }
  missingActive(visible: ReadonlySet<string>, beforeRevision = Infinity): string[] {
    return [...this.operations.values()].filter(row => isActiveOperation(row.value) && row.revision <= beforeRevision && !visible.has(row.value.id)).map(row => row.value.id);
  }
  acceptOperations(snapshot: OperationsResponse, started: number): OperationsResponse {
    const next = new Map<string, OperationRow>();
    for (const value of snapshot.operations) {
      const previous = this.operations.get(value.id);
      next.set(value.id, previous && (previous.revision > started || !operationCanAdvance(previous.value, value)) ? { ...previous, value: newestReview(previous.value, value) } : { value: previous ? newestReview(value, previous.value) : value, revision: ++this.revision, event: previous?.event ?? null });
    }
    for (const [id, previous] of this.operations) if (!next.has(id) && (previous.revision > started || isActiveOperation(previous.value))) next.set(id, previous);
    this.operations = next; this.operationsReady = true;
    return this.activity()!;
  }
  replaceOperations(snapshot: OperationsResponse): OperationsResponse { return this.acceptOperations(snapshot, -1); }
}
