import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRead } from '../ui/src/hooks/useRead.ts';
import { ProviderError } from '../integration/provider.ts';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('invalidación durante un vuelo con cadencia', () => {
  it('la respuesta anterior no vuelve a posponer una invalidación sana otros 60 segundos', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ count: number }>();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ count: 2 });
    const { result } = renderHook(() => useRead(load, true, 60000, vi.fn(), true));
    expect(load).toHaveBeenCalledTimes(1);
    act(() => result.current.refresh());
    await act(async () => pending.resolve({ count: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(101); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual({ count: 2 });
  });
  it('la invalidación y refresh manual no adelantan el Retry-After de una respuesta pendiente', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const pending = deferred<{ count: number }>();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ count: 2 });
    const { result } = renderHook(() => useRead(load, true, 60000, vi.fn(), true));
    act(() => result.current.refresh());
    await act(async () => pending.reject(new ProviderError({ kind: 'http', status: 429, retryAfterSeconds: 120, message: 'fixture' })));
    act(() => result.current.refresh());
    await act(async () => { await vi.advanceTimersByTimeAsync(119999); });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual({ count: 2 });
  });
});
