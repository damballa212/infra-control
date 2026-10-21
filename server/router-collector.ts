import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouterSample } from './router-reports.js';

const MAX_LINE_BYTES = 2048;
const MAX_QUEUED_REPORTS = 4;
const RETRY_SECONDS = [1, 2, 5, 10, 30] as const;
const endpoint = 'http://127.0.0.1:17600/api/router/telemetry';
const sshExecutable = '/usr/bin/ssh';

type SessionResult = { acceptedSamples: number; durationMs: number };

export type RouterRawSample = Omit<RouterSample, 'streamId' | 'sequence'>;

export function parseRouterLine(input: string | Buffer): RouterRawSample {
  const line = typeof input === 'string' ? Buffer.from(input) : input;
  if (line.length === 0 || line.length > MAX_LINE_BYTES) throw new Error('invalid_line_size');
  const value: unknown = JSON.parse(line.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_sample');
  const sample = value as Record<string, unknown>;
  const expected = ['version', 'bootId', 'uptimeSeconds', 'cpuPercent', 'memTotalBytes', 'memAvailableBytes'];
  if (Object.keys(sample).length !== expected.length || expected.some(key => !(key in sample))) throw new Error('invalid_sample_fields');
  if (sample.version !== 1 || typeof sample.bootId !== 'string' || !/^[a-fA-F0-9:-]{8,100}$/.test(sample.bootId)) throw new Error('invalid_identity');
  if (typeof sample.uptimeSeconds !== 'number' || !Number.isFinite(sample.uptimeSeconds) || sample.uptimeSeconds < 0 || sample.uptimeSeconds > 1e12) throw new Error('invalid_uptime');
  if (sample.cpuPercent !== null && (typeof sample.cpuPercent !== 'number' || !Number.isFinite(sample.cpuPercent) || sample.cpuPercent < 0 || sample.cpuPercent > 100)) throw new Error('invalid_cpu');
  if (typeof sample.memTotalBytes !== 'number' || !Number.isSafeInteger(sample.memTotalBytes) || sample.memTotalBytes < 1) throw new Error('invalid_memory_total');
  if (typeof sample.memAvailableBytes !== 'number' || !Number.isSafeInteger(sample.memAvailableBytes) || sample.memAvailableBytes < 0 || sample.memAvailableBytes > sample.memTotalBytes) throw new Error('invalid_memory_available');
  return {
    version: 1,
    bootId: sample.bootId,
    uptimeSeconds: sample.uptimeSeconds,
    cpuPercent: sample.cpuPercent as number | null,
    memTotalBytes: sample.memTotalBytes,
    memAvailableBytes: sample.memAvailableBytes
  };
}

export function buildRouterSample(raw: RouterRawSample, streamId: string, sequence: number): RouterSample {
  if (!/^[a-f0-9-]{36}$/i.test(streamId) || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2147483647) throw new Error('invalid_stream_metadata');
  return { ...raw, streamId, sequence };
}

type CollectorConfig = { sshKey: string; knownHosts: string; token: string };
export function readRouterTelemetryConfig(): CollectorConfig {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) throw new Error('systemd_credentials_required');
  const token = readFileSync(join(directory, 'router-token'), 'utf8').trim();
  if (token.length < 32 || token.length > 512) throw new Error('invalid_router_token_credential');
  return { sshKey: join(directory, 'router-key'), knownHosts: join(directory, 'router-known-hosts'), token };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolveDelay => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolveDelay(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

function classifySshFailure(stderr: string): string | undefined {
  const value = stderr.toLowerCase();
  if (/timeout for no action|idle timeout/.test(value)) return 'ssh_idle_timeout';
  if (/connection timed out|operation timed out/.test(value)) return 'ssh_connect_timeout';
  if (/no route to host|network is unreachable|connection refused/.test(value)) return 'ssh_network_unreachable';
  if (/host key verification failed|remote host identification has changed/.test(value)) return 'ssh_host_key_rejected';
  if (/permission denied|authentication failed/.test(value)) return 'ssh_auth_failed';
  if (/broken pipe|connection reset|connection closed|remote host closed/.test(value)) return 'ssh_transport_closed';
  return stderr.trim() ? 'ssh_error' : undefined;
}

export class RouterTelemetryCollector {
  private child?: ChildProcess;
  private lastPostErrorAt = 0;
  private lastSessionLogAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly config: CollectorConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now,
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly log: (message: string) => void = message => process.stderr.write(`${message}\n`)
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    const stop = () => this.child?.kill('SIGTERM');
    signal.addEventListener('abort', stop, { once: true });
    try {
      while (!signal.aborted) {
        const result = await this.session(signal);
        if (signal.aborted) break;
        if (result.durationMs >= 60_000 || result.acceptedSamples >= 2) failures = 0;
        const base = RETRY_SECONDS[Math.min(failures, RETRY_SECONDS.length - 1)] * 1000;
        failures++;
        const jitter = Math.floor(Math.random() * Math.min(base * 0.2, 1000));
        await delay(base + jitter, signal);
      }
    } finally {
      signal.removeEventListener('abort', stop);
      stop();
    }
  }

  private session(signal: AbortSignal): Promise<SessionResult> {
    return new Promise(resolveSession => {
      if (signal.aborted) { resolveSession({ acceptedSamples: 0, durationMs: 0 }); return; }
      const streamId = randomUUID();
      const started = this.now();
      let sequence = 0;
      let acceptedSamples = 0;
      let lastSampleAt = started;
      let pending = Buffer.alloc(0);
      let queued = 0;
      let queue = Promise.resolve();
      let finished = false;
      let sessionFailed = false;
      let failureReason: string | undefined;
      let sshStderr = '';
      const args = [
        '-F', '/dev/null', '-n', '-T',
        '-oBatchMode=yes', '-oConnectTimeout=5', '-oStrictHostKeyChecking=yes',
        '-oIdentitiesOnly=yes', '-oClearAllForwardings=yes',
        // Keep the inner OpenSSH session active; the vendor dbclient tunnel
        // retains its separate -K0 policy because its own keepalive is broken.
        '-oServerAliveInterval=10', '-oServerAliveCountMax=3',
        `-oUserKnownHostsFile=${this.config.knownHosts}`, '-i', this.config.sshKey,
        '-p', '17722', 'root@127.0.0.1', 'telemetry'
      ];
      const child = this.spawnProcess(sshExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
      this.child = child;
      const end = (exitCode: number | null, closeSignal: NodeJS.Signals | null) => {
        if (finished) return;
        finished = true;
        clearInterval(watchdog);
        signal.removeEventListener('abort', stopSession);
        if (this.child === child) this.child = undefined;
        const durationMs = Math.max(0, this.now() - started);
        void queue.finally(() => {
          if (!signal.aborted && this.now() - this.lastSessionLogAt >= 60_000) {
            this.lastSessionLogAt = this.now();
            const reason = failureReason ?? classifySshFailure(sshStderr) ?? (exitCode === 0 && closeSignal === null ? 'remote_closed' : 'ssh_exit');
            this.log(`router telemetry session ended ${JSON.stringify({ reason, samples: sequence, acceptedSamples, durationMs, exitCode, signal: closeSignal })}`);
          }
          resolveSession({ acceptedSamples, durationMs });
        });
      };
      const stopSession = () => child.kill('SIGTERM');
      const failSession = () => {
        if (sessionFailed) return;
        sessionFailed = true;
        child.kill('SIGTERM');
      };
      const post = async (sample: RouterSample) => {
        if (sessionFailed) return false;
        try {
          const response = await this.fetcher(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(sample),
            redirect: 'error',
            signal: AbortSignal.timeout(5000)
          });
          if (response.status === 204) return true;
        } catch {
          // Keep upstream details and credentials out of the service log.
        }
        const now = this.now();
        if (now - this.lastPostErrorAt >= 60_000) {
          process.stderr.write('router telemetry delivery failed; check local API and credentials\n');
          this.lastPostErrorAt = now;
        }
        return false;
      };
      const acceptLine = (line: Buffer) => {
        if (sessionFailed || line.length === 0) return;
        if (line.at(-1) === 13) line = line.subarray(0, -1);
        try {
          const raw = parseRouterLine(line);
          lastSampleAt = this.now();
          const sample = buildRouterSample(raw, streamId, ++sequence);
          if (queued >= MAX_QUEUED_REPORTS) { failureReason = 'queue_overflow'; failSession(); return; }
          queued++;
          queue = queue.then(async () => {
            if (sessionFailed) return;
            if (await post(sample)) acceptedSamples++;
            else { failureReason ??= 'delivery_failed'; failSession(); }
          }).finally(() => { queued--; });
        } catch {
          failureReason = 'invalid_sample';
          failSession();
        }
      };
      const onData = (chunk: Buffer) => {
        const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let offset = 0;
        for (;;) {
          const newline = data.indexOf(10, offset);
          if (newline < 0) break;
          if (newline - offset > MAX_LINE_BYTES) { failSession(); return; }
          acceptLine(data.subarray(offset, newline));
          offset = newline + 1;
        }
        pending = Buffer.from(data.subarray(offset));
        if (pending.length > MAX_LINE_BYTES) { failureReason = 'invalid_line'; failSession(); }
      };
      const watchdog = setInterval(() => {
        if (this.now() - lastSampleAt > 35_000) { failureReason = 'sample_timeout'; failSession(); }
      }, 5000);
      watchdog.unref();
      signal.addEventListener('abort', stopSession, { once: true });
      child.stdout?.on('data', onData);
      child.stderr?.on('data', chunk => {
        if (sshStderr.length < 1024) sshStderr += Buffer.from(chunk).toString('utf8').slice(0, 1024 - sshStderr.length);
      });
      child.once('error', () => { failureReason = 'ssh_spawn_error'; end(null, null); });
      child.once('close', (code, closeSignal) => end(code, closeSignal));
    });
  }
}

async function main(): Promise<void> {
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());
  const collector = new RouterTelemetryCollector(readRouterTelemetryConfig());
  await collector.run(abort.signal);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { process.stderr.write('router telemetry collector could not start; check service configuration\n'); process.exitCode = 1; });
}
