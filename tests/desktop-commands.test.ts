import { describe, expect, it } from 'vitest';
import { DesktopCommandChannel } from '../server/desktop-commands.js';

const fast = { ackTimeoutMs: 60, deliveredGraceMs: 60, availableMs: 500 };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('canal directo de órdenes a la PC', () => {
  it('no está disponible hasta que el agente se conecta', () => {
    const channel = new DesktopCommandChannel(fast);
    expect(channel.available('windows', 'off')).toBe(false);
  });

  it('entrega la orden al agente que espera y resuelve con la confirmación', async () => {
    const channel = new DesktopCommandChannel(fast);
    const waiting = channel.poll('windows', new Set(['ping', 'power']), 1000);
    expect(channel.available('windows', 'off')).toBe(true);
    const sent = channel.send('windows', 'off', 'boot-1');
    const delivered = await waiting;
    expect(delivered).toMatchObject({ command: 'off', expectedBootId: 'boot-1' });
    expect(channel.ack('windows', delivered!.id, { accepted: true, bootId: 'boot-1' })).toBe(true);
    const result = await sent;
    expect(result.ok).toBe(true);
  });

  it('solo usa el canal para lo que el agente declaró saber hacer', () => {
    const channel = new DesktopCommandChannel(fast);
    void channel.poll('windows', new Set(['ping']), 200);
    expect(channel.available('windows', 'ping')).toBe(true);
    expect(channel.available('windows', 'off')).toBe(false);
    expect(channel.available('windows', 'default-windows')).toBe(false);
  });

  it('cada sistema tiene su propia cola: una orden de Windows no llega al agente de CachyOS', async () => {
    const channel = new DesktopCommandChannel(fast);
    const linux = channel.poll('cachyos', new Set(['ping', 'power']), 150);
    void channel.poll('windows', new Set(['ping', 'power']), 150);
    void channel.send('windows', 'off', 'boot-1');
    expect(await linux).toBeNull();
  });

  it('si el agente no la recoge a tiempo se cancela y no se entregará después', async () => {
    const channel = new DesktopCommandChannel(fast);
    void channel.poll('windows', new Set(['power']), 10);
    await pause(30); // el agente se desconectó entre sondeos pero hubo contacto reciente
    const result = await channel.send('windows', 'off', 'boot-1');
    expect(result).toMatchObject({ ok: false, reason: 'not-delivered' });
    const late = await channel.poll('windows', new Set(['power']), 30);
    expect(late).toBeNull();
  });

  it('entregada pero sin confirmación queda incierta: nunca se puede reenviar por otra vía', async () => {
    const channel = new DesktopCommandChannel(fast);
    const waiting = channel.poll('windows', new Set(['power']), 1000);
    const sent = channel.send('windows', 'windows', 'boot-1');
    await waiting;
    const result = await sent;
    expect(result).toMatchObject({ ok: false, reason: 'uncertain' });
  });

  it('el agente puede rechazar la orden (bootId distinto) y no se da por aceptada', async () => {
    const channel = new DesktopCommandChannel(fast);
    const waiting = channel.poll('windows', new Set(['power']), 1000);
    const sent = channel.send('windows', 'off', 'boot-1');
    const delivered = await waiting;
    expect(channel.ack('windows', delivered!.id, { accepted: true, bootId: 'boot-2' })).toBe(false);
    expect(await sent).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('una confirmación de un sistema ajeno o de una orden desconocida se ignora', async () => {
    const channel = new DesktopCommandChannel(fast);
    const waiting = channel.poll('windows', new Set(['power']), 1000);
    const sent = channel.send('windows', 'off', 'boot-1');
    const delivered = await waiting;
    expect(channel.ack('cachyos', delivered!.id, { accepted: true, bootId: 'boot-1' })).toBe(false);
    expect(channel.ack('windows', 'otra-orden', { accepted: true, bootId: 'boot-1' })).toBe(false);
    channel.ack('windows', delivered!.id, { accepted: true, bootId: 'boot-1' });
    expect((await sent).ok).toBe(true);
  });

  it('un nuevo sondeo reemplaza al anterior sin perder la orden en curso', async () => {
    const channel = new DesktopCommandChannel(fast);
    const first = channel.poll('windows', new Set(['power']), 1000);
    const second = channel.poll('windows', new Set(['power']), 1000);
    expect(await first).toBeNull();
    const sent = channel.send('windows', 'off', 'boot-1');
    const delivered = await second;
    expect(delivered?.command).toBe('off');
    channel.ack('windows', delivered!.id, { accepted: true, bootId: 'boot-1' });
    expect((await sent).ok).toBe(true);
  });

  it('el ping no exige bootId y registra la latencia medida', async () => {
    const channel = new DesktopCommandChannel(fast);
    const waiting = channel.poll('windows', new Set(['ping']), 1000);
    const sent = channel.send('windows', 'ping', '');
    const delivered = await waiting;
    await pause(5);
    channel.ack('windows', delivered!.id, { accepted: true, bootId: 'cualquiera' });
    const result = await sent;
    expect(result.ok).toBe(true);
    expect(channel.snapshot('windows')).toMatchObject({ connected: true, caps: ['ping'] });
    expect(channel.snapshot('windows').lastPingMs).toBeGreaterThanOrEqual(0);
  });

  it('pierde la disponibilidad cuando el agente deja de sondear', async () => {
    const channel = new DesktopCommandChannel({ ...fast, availableMs: 40 });
    void channel.poll('windows', new Set(['power']), 5);
    await pause(80);
    expect(channel.available('windows', 'off')).toBe(false);
    expect(channel.snapshot('windows').connected).toBe(false);
  });
});
