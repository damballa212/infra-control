import type { Operation } from "../contract.ts";
import { ProviderError } from "../../../integration/provider.ts";
import { LiveState } from "./liveState.ts";
import { nextDelayMs } from "./poller.ts";
interface Job { id: string; epoch: number; promise: Promise<Operation>; resolve: (value: Operation) => void; reject: (failure: unknown) => void }
/** GET individuales compartidos, secuenciales y singleflight por id. No reintenta por su cuenta. */
export class OperationReader {
  private epoch = 0; private alive = true; private running = false;
  private queue: Job[] = []; private jobs = new Map<string, Job>();
  private deadline = 0; private failures = 0; private turn = 0; private attempted = new Map<string, number>();
  constructor(private readonly deps: { store: LiveState; get: (id: string) => Promise<Operation>; available: () => boolean; changed: () => void; unauthorized: () => void }) {}
  get retryAt() { return this.deadline; }
  activate() { this.alive = true; this.epoch += 1; }
  deactivate() {
    this.alive = false; this.epoch += 1;
    for (const job of this.jobs.values()) job.reject(new Error("El contexto autenticado terminó"));
    this.jobs.clear(); this.queue = [];
  }
  defer(failure: unknown) {
    this.failures += 1;
    const delay = nextDelayMs({ baseMs: 5000, failures: this.failures, retryAfterSeconds: failure instanceof ProviderError ? failure.retryAfterSeconds : null, random: Math.random() });
    this.deadline = Math.max(this.deadline, Date.now() + delay);
  }
  checkDeadline() {
    if (Date.now() < this.deadline) throw new ProviderError({ kind: "http", status: 429, retryAfterSeconds: Math.ceil((this.deadline - Date.now()) / 1000), message: "Espera antes de volver a consultar las órdenes" });
  }
  read = (id: string): Promise<Operation> => {
    const existing = this.jobs.get(id); if (existing) return existing.promise;
    if (!this.alive || !this.deps.available()) return Promise.reject(new Error("Lectura pausada o sesión terminada"));
    try { this.checkDeadline(); } catch (failure) { return Promise.reject(failure); }
    let resolve!: Job["resolve"]; let reject!: Job["reject"];
    const promise = new Promise<Operation>((yes, no) => { resolve = yes; reject = no; });
    const job = { id, epoch: this.epoch, promise, resolve, reject };
    this.jobs.set(id, job); this.queue.push(job); void this.pump(); return promise;
  };
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          if (!this.alive || job.epoch !== this.epoch || !this.deps.available()) throw new Error("Lectura pausada o sesión terminada");
          this.checkDeadline();
          this.attempted.set(job.id, ++this.turn);
          const started = this.deps.store.begin();
          const value = await this.deps.get(job.id);
          if (!this.alive || job.epoch !== this.epoch || !this.deps.available()) throw new Error("El contexto cambió durante la lectura");
          if (!value || value.id !== job.id || typeof value.state !== "string" || typeof value.updatedAt !== "string") throw new Error("Respuesta individual de orden inválida");
          const current = this.deps.store.acceptOperationRead(value, started);
          this.failures = 0; this.deps.changed(); job.resolve(current);
        } catch (failure) {
          if (this.alive && job.epoch === this.epoch) {
            if (failure instanceof ProviderError && failure.status === 401) { this.deactivate(); this.deps.unauthorized(); }
            else if (Date.now() >= this.deadline) this.defer(failure);
          }
          job.reject(failure);
        } finally { if (this.jobs.get(job.id) === job) this.jobs.delete(job.id); }
      }
    } finally { this.running = false; }
  }
  async recoverOutside(visible: ReadonlySet<string>, started: number, limit = 2): Promise<void> {
    const ids = this.deps.store.missingActive(visible, started).sort((a, b) => (this.attempted.get(a) ?? 0) - (this.attempted.get(b) ?? 0) || a.localeCompare(b));
    for (const id of ids.slice(0, Math.max(0, limit))) {
      if (!this.alive || !this.deps.available()) return;
      if (!this.deps.store.missingActive(visible).includes(id)) continue;
      await this.read(id);
    }
  }
}
