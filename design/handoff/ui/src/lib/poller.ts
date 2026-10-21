import { ProviderError } from "../../../integration/provider.ts";

const MAX_BACKOFF_MS = 5 * 60 * 1000;

export interface BackoffInput {
  baseMs: number;
  failures: number;
  retryAfterSeconds: number | null;
  /** Número en [0, 1): inyectable para pruebas. */
  random: number;
  maxMs?: number;
}

/** Sin fallos: el intervalo base. Con fallos: backoff exponencial con jitter (50–100 %) y `Retry-After` como mínimo. */
export function nextDelayMs({
  baseMs,
  failures,
  retryAfterSeconds,
  random,
  maxMs = MAX_BACKOFF_MS,
}: BackoffInput): number {
  const retryAfterMs =
    retryAfterSeconds === null ? 0 : Math.max(0, retryAfterSeconds) * 1000;
  if (failures <= 0) return Math.max(baseMs, retryAfterMs);
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(failures, 8));
  const jittered = exponential * (0.5 + random * 0.5);
  return Math.max(Math.round(jittered), retryAfterMs);
}

export interface PollerDeps {
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  random(): number;
}

const realDeps: PollerDeps = {
  setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export interface PollerOptions {
  intervalMs: number;
  task: () => Promise<void>;
  onFailure?: (error: unknown, failures: number, nextDelayMs: number) => void;
  deps?: Partial<PollerDeps>;
}

export interface Poller {
  /** Arranca el ciclo; con `immediate` ejecuta ya (si no, espera un intervalo). */
  start(immediate: boolean): void;
  /** Cancela el temporizador. Una tarea en vuelo termina pero no reprograma. */
  stop(): void;
  /** Ejecuta ahora salvo que haya una tarea en vuelo (nunca solapa solicitudes). */
  trigger(): void;
  readonly inFlight: boolean;
  readonly failures: number;
}

export function createPoller(options: PollerOptions): Poller {
  const deps: PollerDeps = { ...realDeps, ...options.deps };
  let timer: unknown = null;
  let active = false;
  let inFlight = false;
  let failures = 0;

  const clear = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const schedule = (delayMs: number): void => {
    clear();
    if (!active) return;
    timer = deps.setTimer(() => void run(), delayMs);
  };

  const run = async (): Promise<void> => {
    if (inFlight || !active) return;
    clear();
    inFlight = true;
    try {
      await options.task();
      failures = 0;
      schedule(
        nextDelayMs({
          baseMs: options.intervalMs,
          failures: 0,
          retryAfterSeconds: null,
          random: 0,
        }),
      );
    } catch (error: unknown) {
      failures += 1;
      const retryAfter =
        error instanceof ProviderError ? error.retryAfterSeconds : null;
      const delay = nextDelayMs({
        baseMs: options.intervalMs,
        failures,
        retryAfterSeconds: retryAfter,
        random: deps.random(),
      });
      options.onFailure?.(error, failures, delay);
      schedule(delay);
    } finally {
      inFlight = false;
    }
  };

  return {
    start(immediate) {
      active = true;
      if (immediate) void run();
      else schedule(options.intervalMs);
    },
    stop() {
      active = false;
      clear();
    },
    trigger() {
      void run();
    },
    get inFlight() {
      return inFlight;
    },
    get failures() {
      return failures;
    },
  };
}
