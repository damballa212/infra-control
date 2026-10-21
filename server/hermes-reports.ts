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
type Journal = { current?: Accepted; retiredBoots: string[]; retiredStreams: string[]; publishedKey?: string; publishedExpectedTransition?: boolean };

const JOURNAL_KEY = 'hermes-reports-v1';
const FRESHNESS_TTL = 45_000;
const EXPECTED_OPERATION_WINDOW = 10 * 60_000;

function emptyJournal(): Journal { return { retiredBoots: [], retiredStreams: [] }; }

function keyFor(snapshot: HermesSnapshot): string {
  return `${snapshot.state}:${snapshot.serviceState}:${snapshot.bootId}:${snapshot.streamId}:${snapshot.restartCount}:${snapshot.expectedTransition}`;
}

export class HermesReports {
  private expiryTimer?: NodeJS.Timeout;

  constructor(private readonly store: Store, private readonly expectedResourceIds: string[], private readonly now = Date.now) {
    const journal = this.read();
    if (journal.current) {
      const snapshot = this.snapshot(journal.current)!;
      if (journal.publishedKey !== keyFor(snapshot)) this.publish(journal, journal.current);
      this.scheduleExpiry();
    }
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

  private expectedTransition(): boolean {
    const since = new Date(this.now() - EXPECTED_OPERATION_WINDOW).toISOString();
    return this.expectedResourceIds.some(id =>
      this.store.recentExpectedOperation(id, 'start', since) || this.store.recentExpectedOperation(id, 'stop', since)
    );
  }

  private snapshot(current = this.read().current): HermesSnapshot | undefined {
    if (!current) return undefined;
    const age = Math.max(0, this.now() - current.receivedAt);
    const state: HermesSnapshot['state'] = age >= FRESHNESS_TTL
      ? 'stale'
      : current.sample.serviceState === 'active' ? 'healthy'
        : current.sample.serviceState === 'failed' || current.sample.serviceState === 'inactive' ? 'unhealthy' : 'unknown';
    const expectedTransition = this.expectedTransition();
    return {
      state, serviceState: current.sample.serviceState, lastServiceState: current.sample.serviceState,
      resourceId: this.expectedResourceIds[0] ?? null,
      bootId: current.sample.bootId, streamId: current.sample.streamId, sequence: current.sample.sequence,
      restartCount: current.sample.restartCount,
      observedAt: new Date(current.receivedAt).toISOString(),
      freshUntil: new Date(current.receivedAt + FRESHNESS_TTL).toISOString(),
      ageSeconds: Math.floor(age / 1000), expectedTransition,
      reasonCode: age >= FRESHNESS_TTL ? expectedTransition ? 'expected_ec2_transition' : 'heartbeat_timeout'
        : state === 'healthy' ? 'systemd_unit_active'
          : state === 'unhealthy' ? expectedTransition ? 'expected_ec2_transition' : 'systemd_unit_inactive'
            : 'systemd_state_unknown'
    };
  }

  private publish(journal: Journal, current: Accepted): void {
    const snapshot = this.snapshot(current);
    if (!snapshot) return;
    const previousState = this.previousState(journal, snapshot);
    const previousExpectedTransition = journal.publishedExpectedTransition === true;
    journal.publishedKey = keyFor(snapshot);
    journal.publishedExpectedTransition = snapshot.expectedTransition;
    const isFailure = snapshot.state === 'unhealthy' && previousState !== 'unhealthy'
      || snapshot.state === 'unhealthy' && previousExpectedTransition && !snapshot.expectedTransition
      || snapshot.state === 'stale' && previousState === 'healthy';
    const isRecovery = snapshot.state === 'healthy' && (previousState === 'unhealthy' || previousState === 'stale');
    const payload = {
      category: 'infrastructure', resourceId: snapshot.resourceId, resourceName: 'Hermes',
      from: previousState ?? 'unknown', to: snapshot.state, state: snapshot.state,
      serviceState: snapshot.serviceState, restartCount: snapshot.restartCount,
      observedAt: snapshot.observedAt, reasonCode: snapshot.reasonCode,
      ...(snapshot.expectedTransition ? { expectedTransition: true } : {})
    };
    this.store.atomic(() => {
      this.write(journal);
      if ((isFailure || isRecovery) && !snapshot.expectedTransition) this.store.appendEvent('incident', 'hermes:orchestrator', payload);
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
    const snapshot = this.snapshot(current)!;
    if (journal.publishedKey !== keyFor(snapshot)) this.publish(journal, current);
    else this.write(journal);
    this.scheduleExpiry();
    return true;
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const current = this.read().current;
    if (!current || this.now() - current.receivedAt >= FRESHNESS_TTL) return;
    const expected = `${current.sample.bootId}:${current.sample.streamId}:${current.sample.sequence}:${current.receivedAt}`;
    this.expiryTimer = setTimeout(() => {
      const journal = this.read(), latest = journal.current;
      if (latest && `${latest.sample.bootId}:${latest.sample.streamId}:${latest.sample.sequence}:${latest.receivedAt}` === expected && this.now() - latest.receivedAt >= FRESHNESS_TTL) {
        const snapshot = this.snapshot(latest)!;
        if (journal.publishedKey !== keyFor(snapshot)) this.publish(journal, latest);
      }
      this.scheduleExpiry();
    }, Math.max(0, current.receivedAt + FRESHNESS_TTL - this.now()));
    this.expiryTimer.unref();
  }

  status(): HermesSnapshot | undefined { return this.snapshot(); }

  close(): void { if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined; }
}
