import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRouterSample, parseRouterLine, readRouterTelemetryConfig, RouterTelemetryCollector } from '../server/router-collector.js';

type SpawnFake = (command: string, args: readonly string[], options?: unknown) => ChildProcess;

const valid = {
  version: 1,
  bootId: 'f1b2c3d4-5678-90ab-cdef-0123456789ab',
  uptimeSeconds: 86400,
  cpuPercent: 12,
  memTotalBytes: 128 * 1024 * 1024,
  memAvailableBytes: 64 * 1024 * 1024
};

describe('protocolo acotado del colector FiberHome', () => {
  it('valida muestras de solo lectura y conserva CPU desconocida en el primer ciclo', () => {
    expect(parseRouterLine(JSON.stringify({ ...valid, cpuPercent: null }))).toEqual({ ...valid, cpuPercent: null });
  });

  it('rechaza campos inesperados, valores fuera de rango y líneas sobredimensionadas', () => {
    expect(() => parseRouterLine(JSON.stringify({ ...valid, wanAddress: '198.51.100.4' }))).toThrow();
    expect(() => parseRouterLine(JSON.stringify({ ...valid, memAvailableBytes: valid.memTotalBytes + 1 }))).toThrow();
    expect(() => parseRouterLine('x'.repeat(2049))).toThrow();
    expect(() => parseRouterLine('')).toThrow('invalid_line_size');
    expect(() => parseRouterLine('{')).toThrow();
    expect(() => parseRouterLine('[]')).toThrow('invalid_sample');
    expect(() => parseRouterLine(JSON.stringify({ ...valid, version: 2 }))).toThrow('invalid_identity');
    expect(() => parseRouterLine(JSON.stringify({ ...valid, bootId: 'short' }))).toThrow('invalid_identity');
    expect(() => parseRouterLine(JSON.stringify({ ...valid, uptimeSeconds: Infinity }))).toThrow('invalid_uptime');
    expect(() => parseRouterLine(JSON.stringify({ ...valid, cpuPercent: 101 }))).toThrow('invalid_cpu');
    expect(() => parseRouterLine(JSON.stringify({ ...valid, cpuPercent: '12' }))).toThrow('invalid_cpu');
    expect(() => parseRouterLine(JSON.stringify({ ...valid, memTotalBytes: 0 }))).toThrow('invalid_memory_total');
    expect(() => parseRouterLine(JSON.stringify({ ...valid, memAvailableBytes: -1 }))).toThrow('invalid_memory_available');
  });

  it('enriquece cada conexión con streamId nuevo y secuencia monotónica', () => {
    const raw = parseRouterLine(JSON.stringify(valid));
    const streamId = 'f5b5e92a-f7ca-4c88-8bb0-5024ccdb1ca4';
    expect(buildRouterSample(raw, streamId, 1)).toEqual({ ...raw, streamId, sequence: 1 });
    expect(() => buildRouterSample(raw, streamId, 0)).toThrow();
    expect(() => buildRouterSample(raw, 'not-a-uuid', 1)).toThrow();
    expect(() => buildRouterSample(raw, streamId, 2147483648)).toThrow();
  });
});

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: string[] = [];
  kill(signal = 'SIGTERM'): boolean {
    this.kills.push(signal);
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

describe('sesión del colector saliente del FiberHome', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('lee credenciales solo desde systemd y valida que el token no esté vacío ni corto', () => {
    vi.stubEnv('CREDENTIALS_DIRECTORY', '');
    expect(() => readRouterTelemetryConfig()).toThrow('systemd_credentials_required');
    vi.stubEnv('CREDENTIALS_DIRECTORY', '/run/credentials/router.service');
    expect(() => readRouterTelemetryConfig()).toThrow('ENOENT');
  });

  it('envía muestras separadas en fragmentos, con secuencia por stream y SSH fijado a loopback', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn<SpawnFake>(() => child as unknown as ChildProcess);
    const fetcher = vi.fn<typeof fetch>(async () => ({ status: 204 } as Response));
    const log = vi.fn<(message: string) => void>();
    const controller = new AbortController();
    const collector = new RouterTelemetryCollector(
      { sshKey: '/credential/router-key', knownHosts: '/credential/known-hosts', token: 'private-token-never-log' },
      fetcher,
      () => 100_000,
      spawnProcess as unknown as typeof import('node:child_process').spawn,
      log
    );
    const running = collector.run(controller.signal);
    const [file, args, options] = spawnProcess.mock.calls[0]!;
    expect(file).toBe('/usr/bin/ssh');
    expect(args).toContain('-oStrictHostKeyChecking=yes');
    expect(args).toContain('-oClearAllForwardings=yes');
    expect(args).toContain('-oServerAliveInterval=10');
    expect(args).toContain('-oServerAliveCountMax=3');
    expect(args).toContain('root@127.0.0.1');
    expect(args.slice(-1)).toEqual(['telemetry']);
    expect(options).toMatchObject({ env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });

    const line = JSON.stringify(valid);
    child.stdout.emit('data', Buffer.from(line.slice(0, 27)));
    child.stdout.emit('data', Buffer.from(`${line.slice(27)}\r\n${line}\n`));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const first = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    const second = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(first).toMatchObject({ ...valid, sequence: 1 });
    expect(second).toMatchObject({ ...valid, sequence: 2, streamId: first.streamId });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer private-token-never-log', 'Content-Type': 'application/json' }
    });

    child.emit('close', 0, null);
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    controller.abort();
    await running;
    expect(log.mock.calls[0]![0]).toContain('"samples":2');
  });

  it('logs a sanitized transport cause without forwarding SSH stderr or credentials', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn<SpawnFake>(() => child as unknown as ChildProcess);
    const fetcher = vi.fn<typeof fetch>(async () => ({ status: 204 } as Response));
    const log = vi.fn<(message: string) => void>();
    const controller = new AbortController();
    const collector = new RouterTelemetryCollector(
      { sshKey: '/key', knownHosts: '/known-hosts', token: 'private-token-never-log' }, fetcher, () => 1000,
      spawnProcess as unknown as typeof import('node:child_process').spawn, log
    );
    const running = collector.run(controller.signal);
    child.stderr.emit('data', Buffer.from('client_loop: send disconnect: Broken pipe private-token-never-log\n'));
    child.emit('close', 255, null);
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    controller.abort();
    await running;
    expect(log.mock.calls[0]![0]).toContain('"reason":"ssh_transport_closed"');
    expect(log.mock.calls[0]![0]).toContain('"exitCode":255');
    expect(log.mock.calls[0]![0]).not.toContain('private-token-never-log');
    expect(log.mock.calls[0]![0]).not.toContain('Broken pipe');
  });

  it('classifies Dropbear idle timeout without logging raw stderr and counts accepted samples', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn<SpawnFake>(() => child as unknown as ChildProcess);
    const fetcher = vi.fn<typeof fetch>(async () => ({ status: 204 } as Response));
    const log = vi.fn<(message: string) => void>();
    const controller = new AbortController();
    const collector = new RouterTelemetryCollector(
      { sshKey: '/key', knownHosts: '/known-hosts', token: 'private-token-never-log' }, fetcher, () => 1000,
      spawnProcess as unknown as typeof import('node:child_process').spawn, log
    );
    const running = collector.run(controller.signal);
    child.stderr.emit('data', Buffer.from('Timeout for no action private-token-never-log\n'));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await Promise.all(fetcher.mock.results.map(result => result.type === 'return' ? result.value : undefined));
    child.emit('close', 255, null);
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    controller.abort();
    await running;
    expect(log.mock.calls[0]![0]).toContain('"reason":"ssh_idle_timeout"');
    expect(log.mock.calls[0]![0]).toContain('"acceptedSamples":2');
    expect(log.mock.calls[0]![0]).not.toContain('Timeout for no action');
    expect(log.mock.calls[0]![0]).not.toContain('private-token-never-log');
  });

  it('retries a productive short stream promptly but backs off when the next stream yields nothing', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn<SpawnFake>(() => {
      const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess;
    });
    const fetcher = vi.fn<typeof fetch>(async () => ({ status: 204 } as Response));
    const log = vi.fn<(message: string) => void>();
    const controller = new AbortController();
    const collector = new RouterTelemetryCollector(
      { sshKey: '/key', knownHosts: '/known-hosts', token: 'x'.repeat(32) }, fetcher, Date.now,
      spawnProcess as unknown as typeof import('node:child_process').spawn, log
    );
    const running = collector.run(controller.signal);
    const sendTwoSamples = async (child: FakeChild, offset: number) => {
      const line = `${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`;
      child.stdout.emit('data', Buffer.from(line));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(offset + 2));
      await Promise.all(fetcher.mock.results.slice(offset).map(result => result.type === 'return' ? result.value : undefined));
    };
    await sendTwoSamples(children[0]!, 0);
    await vi.advanceTimersByTimeAsync(32_000);
    children[0]!.emit('close', 255, null);
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);

    await sendTwoSamples(children[1]!, 2);
    await vi.advanceTimersByTimeAsync(32_000);
    children[1]!.emit('close', 255, null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(3);

    children[2]!.emit('close', 255, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(4);

    controller.abort();
    await running;
  });

  it('conserva queue_overflow al cancelar publicaciones y cerrar el transporte', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn<SpawnFake>(() => child as unknown as ChildProcess);
    const fetcher = vi.fn<typeof fetch>(async () => ({ status: 204 } as Response));
    const log = vi.fn<(message: string) => void>();
    const controller = new AbortController();
    const collector = new RouterTelemetryCollector(
      { sshKey: '/key', knownHosts: '/known-hosts', token: 'x'.repeat(32) }, fetcher, () => 1000,
      spawnProcess as unknown as typeof import('node:child_process').spawn, log
    );
    const running = collector.run(controller.signal);
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(valid)}\n`.repeat(5)));
    child.stderr.emit('data', Buffer.from('Connection closed by remote host\n'));
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    controller.abort();
    await running;
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toContain('"reason":"queue_overflow"');
    expect(log.mock.calls[0]![0]).toContain('"acceptedSamples":0');
  });

  it('termina una sesión al recibir una muestra inválida y no la publica', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn<SpawnFake>(() => child as unknown as ChildProcess);
    const fetcher = vi.fn<typeof fetch>(async () => ({ status: 204 } as Response));
    const log = vi.fn<(message: string) => void>();
    const controller = new AbortController();
    const collector = new RouterTelemetryCollector(
      { sshKey: '/key', knownHosts: '/known-hosts', token: 'x'.repeat(32) }, fetcher, () => 1000, spawnProcess as unknown as typeof import('node:child_process').spawn, log
    );
    const running = collector.run(controller.signal);
    child.stdout.emit('data', Buffer.from('{"unexpected":true}\n'));
    await vi.waitFor(() => expect(child.kills).toContain('SIGTERM'));
    controller.abort();
    await running;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('termina el túnel cuando el endpoint local no confirma exactamente HTTP 204', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn<SpawnFake>(() => child as unknown as ChildProcess);
    const fetcher = vi.fn<typeof fetch>(async () => ({ status: 202 } as Response));
    const log = vi.fn<(message: string) => void>();
    const controller = new AbortController();
    const collector = new RouterTelemetryCollector(
      { sshKey: '/key', knownHosts: '/known-hosts', token: 'x'.repeat(32) }, fetcher, () => 1000, spawnProcess as unknown as typeof import('node:child_process').spawn, log
    );
    const running = collector.run(controller.signal);
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(valid)}\n`));
    await vi.waitFor(() => expect(child.kills).toContain('SIGTERM'));
    controller.abort();
    await running;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
