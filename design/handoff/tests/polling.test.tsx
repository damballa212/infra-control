import { act, renderHook } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import { useRead } from "../ui/src/hooks/useRead.ts";
import { ProviderError } from "../integration/provider.ts";
import { nextDelayMs } from "../ui/src/lib/poller.ts";
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
it("no solapa llamadas aunque se refresque varias veces", async () => {
  vi.useFakeTimers();
  let finish!: (n: number) => void;
  const load = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const { result, unmount } = renderHook(() =>
    useRead(load, true, 60000, vi.fn()),
  );
  await flush();
  act(() => {
    result.current.refresh();
    result.current.refresh();
  });
  await flush(60000);
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(42);
  });
  expect(result.current.data).toBe(42);
  unmount();
});
it("429 conserva Retry-After al refrescar y al ocultar/mostrar", async () => {
  vi.useFakeTimers();
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  const load = vi
    .fn()
    .mockRejectedValueOnce(
      new ProviderError({
        kind: "http",
        status: 429,
        retryAfterSeconds: 120,
        message: "espera",
      }),
    )
    .mockResolvedValue(42);
  const { result } = renderHook(() => useRead(load, true, 60000, vi.fn()));
  await flush();
  expect(result.current.retryAt).toBeGreaterThan(Date.now());
  act(() => {
    result.current.refresh();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush(60000);
  act(() => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush(59000);
  expect(load).toHaveBeenCalledTimes(1);
  await flush(1000);
  expect(load).toHaveBeenCalledTimes(2);
});
it("offline y pestaña oculta detienen nuevas lecturas; vuelve sin ráfaga", async () => {
  vi.useFakeTimers();
  let visible = "visible";
  let online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visible as DocumentVisibilityState,
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  const load = vi.fn().mockResolvedValue(42);
  renderHook(() => useRead(load, true, 60000, vi.fn()));
  await flush();
  expect(load).toHaveBeenCalledTimes(1);
  act(() => {
    visible = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush(180000);
  expect(load).toHaveBeenCalledTimes(1);
  act(() => {
    visible = "visible";
    online = false;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("offline"));
  });
  await flush(120000);
  expect(load).toHaveBeenCalledTimes(1);
  act(() => {
    online = true;
    window.dispatchEvent(new Event("online"));
  });
  await flush();
  expect(load).toHaveBeenCalledTimes(2);
});
it("401 solicita limpieza de la sesión", async () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  renderHook(() =>
    useRead(
      async () => {
        throw new ProviderError({
          kind: "http",
          status: 401,
          message: "sesión",
        });
      },
      true,
      60000,
      expired,
    ),
  );
  await flush();
  expect(expired).toHaveBeenCalledTimes(1);
});
it("un resultado tardío tras desmontar no alcanza el árbol siguiente", async () => {
  let done!: (n: number) => void;
  const { unmount } = renderHook(() =>
    useRead(
      () =>
        new Promise<number>((resolve) => {
          done = resolve;
        }),
      true,
      null,
      vi.fn(),
    ),
  );
  unmount();
  await act(async () => done(99));
});
it("backoff con jitter y Retry-After siempre respeta el mínimo", () => {
  expect(
    nextDelayMs({
      baseMs: 1000,
      failures: 2,
      retryAfterSeconds: 90,
      random: 0,
    }),
  ).toBe(90000);
  expect(
    nextDelayMs({
      baseMs: 1000,
      failures: 1,
      retryAfterSeconds: null,
      random: 0,
    }),
  ).toBe(1000);
});
