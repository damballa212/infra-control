import type { Store } from './store.js';

export type HermesReport = {
  version: 1;
  bootId: string;
  streamId: string;
  sequence: number;
  serviceState: 'active' | 'inactive' | 'failed' | 'unknown';
  restartCount: number;
};

export type HermesSnapshot = {
  state: 'healthy' | 'unhealthy' | 'stale' | 'unknown';
  serviceState: HermesReport['serviceState'];
  lastServiceState: HermesReport['serviceState'];
  resourceId: string | null;
  bootId: string;
  streamId: string;
  sequence: number;
  restartCount: number;
  observedAt: string;
  freshUntil: string;
  ageSeconds: number;
  expectedTransition: boolean;
  reasonCode: string;
};

type Accepted = { sample: HermesReport; receivedAt: number };
type Journal = { current?: Accepted; retiredBoots: string[]; retiredStreams: string[]; publishedKey?: string; publishedExpectedTransition?: boolean; outageOpen?: boolean };

const JOURNAL_KEY = 'hermes-reports-v1';
const FRESHNESS_TTL = 45_000;
const OUTAGE_AGGREGATE = 'hermes:orchestrator';

function emptyJournal(): Journal { return { retiredBoots: [], retiredStreams: [] }; }

function keyFor(snapshot: HermesSnapshot): string {
  return `${snapshot.state}:${snapshot.serviceState}:${snapshot.bootId}:${snapshot.streamId}:${snapshot.restartCount}:${snapshot.expectedTransition}`;
}

export class HermesReports {
  private expiryTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private sampleListeners = new Set<() => void>();

  subscribeSamples(listener: () => void): () => void {
    this.sampleListeners.add(listener);
    return () => { this.sampleListeners.delete(listener); };
  }

  constructor(private readonly store: Store, private readonly expectedResourceIds: string[], private readonly now = Date.now) {
    const journal = this.read();
    if (journal.outageOpen === undefined) {
      const row = this.store.db.prepare("SELECT payload FROM event_log WHERE type='incident' AND aggregate_id=? ORDER BY id DESC LIMIT 1").get(OUTAGE_AGGREGATE) as { payload: string } | undefined;
      let prior: unknown;
      try { prior = row ? (JSON.parse(row.payload) as { to?: unknown }).to : undefined; } catch { prior = undefined; }
      journal.outageOpen = prior === 'unhealthy' || prior === 'stale';
      this.write(journal);
    }
    if (journal.current) {
      const snapshot = this.snapshot(journal.current)!;
      if (journal.publishedKey !== keyFor(snapshot)) this.publish(journal, journal.current);
      this.scheduleExpiry();
    }
    this.unsubscribe = this.store.subscribeEvents(() => {
      const current = this.read();
      if (current.current && current.publishedKey !== keyFor(this.snapshot(current.current)!)) this.publish(current, current.current);
      this.scheduleExpiry();
    });
  }

  private read(): Journal {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(JOURNAL_KEY) as { value: string } | undefined;
    if (!row) return emptyJournal();
    try {
      const journal = JSON.parse(row.value) as Journal;
      if (!Array.isArray(journal.retiredBoots) || !Array.isArray(journal.retiredStreams)) return emptyJournal();
      return journal;
    } catch { return emptyJournal(); }
  }

  private write(journal: Journal): void {
    this.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(JOURNAL_KEY, JSON.stringify(journal));
  }

  private expectation() {
    return this.store.expectations.context(this.expectedResourceIds, this.now());
  }

  private snapshot(current = this.read().current): HermesSnapshot | undefined {
    if (!current) return undefined;
    const age = Math.max(0, this.now() - current.receivedAt);
    const state: HermesSnapshot['state'] = age >= FRESHNESS_TTL
      ? 'stale'
      : current.sample.serviceState === 'active' ? 'healthy'
        : current.sample.serviceState === 'failed' || current.sample.serviceState === 'inactive' ? 'unhealthy' : 'unknown';
    const expectation = this.expectation();
    const expectedTransition = expectation.expected;
    return {
      state, serviceState: current.sample.serviceState, lastServiceState: current.sample.serviceState,
      resourceId: this.expectedResourceIds[0] ?? null,
      bootId: current.sample.bootId, streamId: current.sample.streamId, sequence: current.sample.sequence,
      restartCount: current.sample.restartCount,
      observedAt: new Date(current.receivedAt).toISOString(),
      freshUntil: new Date(current.receivedAt + FRESHNESS_TTL).toISOString(),
      ageSeconds: Math.floor(age / 1000), expectedTransition,
      reasonCode: age >= FRESHNESS_TTL ? expectedTransition ? expectation.reasonCode! : 'heartbeat_timeout'
        : state === 'healthy' ? 'systemd_unit_active'
          : state === 'unhealthy' ? expectedTransition ? expectation.reasonCode! : 'systemd_unit_inactive'
            : 'systemd_state_unknown'
    };
  }

  private publish(journal: Journal, current: Accepted): void {
    const snapshot = this.snapshot(current);
    if (!snapshot) return;
    const previousState = this.previousState(journal, snapshot);
    journal.publishedKey = keyFor(snapshot);
    journal.publishedExpectedTransition = snapshot.expectedTransition;
    const isFailure = !snapshot.expectedTransition && !journal.outageOpen && (snapshot.state === 'unhealthy' || snapshot.state === 'stale');
    const isRecovery = snapshot.state === 'healthy' && journal.outageOpen === true;
    if (isFailure) journal.outageOpen = true;
    if (isRecovery) journal.outageOpen = false;
    const payload = {
      category: 'infrastructure', resourceId: snapshot.resourceId, resourceName: 'Hermes',
      from: previousState ?? 'unknown', to: snapshot.state, state: snapshot.state,
      serviceState: snapshot.serviceState, restartCount: snapshot.restartCount,
      observedAt: snapshot.observedAt, reasonCode: snapshot.reasonCode,
      ...(snapshot.expectedTransition ? { expectedTransition: true } : {})
    };
    this.store.atomic(() => {
      this.write(journal);
      if (isFailure || isRecovery) this.store.appendEvent('incident', OUTAGE_AGGREGATE, payload);
      else this.store.appendEvent('resource', 'hermes:orchestrator', payload);
    });
  }

  private previousState(journal: Journal, next: HermesSnapshot): HermesSnapshot['state'] | undefined {
    const priorKey = journal.publishedKey;
    if (!priorKey) return undefined;
    const state = priorKey.split(':', 1)[0];
    return state === 'healthy' || state === 'unhealthy' || state === 'stale' || state === 'unknown' ? state : next.state;
  }

  accept(sample: HermesReport): boolean {
    const journal = this.read(), old = journal.current;
    if (journal.retiredStreams.includes(sample.streamId) || journal.retiredBoots.includes(sample.bootId)) return false;
    if (old) {
      const sameStream = old.sample.streamId === sample.streamId;
      if (sameStream) {
        if (sample.sequence < old.sample.sequence) return false;
        if (sample.sequence === old.sample.sequence) return JSON.stringify(sample) === JSON.stringify(old.sample);
      } else {
        if (sample.sequence !== 1) return false;
        journal.retiredStreams = [...journal.retiredStreams, old.sample.streamId].slice(-64);
      }
      if (old.sample.bootId !== sample.bootId) {
        if (sample.sequence !== 1) return false;
        journal.retiredBoots = [...journal.retiredBoots, old.sample.bootId].slice(-64);
      }
    } else if (sample.sequence !== 1) return false;

    const current = { sample, receivedAt: this.now() };
    journal.current = current;
    if (sample.serviceState === 'active') for (const id of this.expectedResourceIds) this.store.expectations.healthy(id, new Date(current.receivedAt).toISOString());
    const snapshot = this.snapshot(current)!;
    if (journal.publishedKey !== keyFor(snapshot)) this.publish(journal, current);
    else this.write(journal);
    this.scheduleExpiry();
    for (const listener of this.sampleListeners) { try { listener(); } catch { /* La proyección no invalida la muestra. */ } }
    return true;
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const current = this.read().current;
    if (!current) return;
    const now = this.now(), expectation = this.expectation();
    const boundaries = [current.receivedAt + FRESHNESS_TTL, expectation.expiresAt ? Date.parse(expectation.expiresAt) : NaN].filter(value => Number.isFinite(value) && value > now);
    if (!boundaries.length) return;
    this.expiryTimer = setTimeout(() => {
      const journal = this.read(), latest = journal.current;
      if (latest) {
        const snapshot = this.snapshot(latest)!;
        if (journal.publishedKey !== keyFor(snapshot)) this.publish(journal, latest);
      }
      this.scheduleExpiry();
    }, Math.max(1, Math.min(...boundaries) - now));
    this.expiryTimer.unref();
  }

  status(): HermesSnapshot | undefined { return this.snapshot(); }

  close(): void { this.unsubscribe?.(); this.unsubscribe = undefined; if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined; this.sampleListeners.clear(); }
}
