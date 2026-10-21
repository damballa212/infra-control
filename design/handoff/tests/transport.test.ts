import { it, expect, vi } from "vitest";
import { createHttpProvider } from "../integration/httpProvider.ts";
import { IntentController } from "../ui/src/lib/intent.ts";
import { ProviderError } from "../integration/provider.ts";
it("no reenvía una escritura ambigua; recuperar conserva clave y petición", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(
      new ProviderError({ kind: "network", ambiguous: true, message: "corte" }),
    )
    .mockResolvedValue({ id: "same-order" });
  const intent = new IntentController(send);
  await expect(
    intent.submit({ resourceId: "one", action: "stop", confirmed: true }),
  ).rejects.toThrow("corte");
  expect(send).toHaveBeenCalledTimes(1);
  await expect(
    intent.submit({ resourceId: "two", action: "start" }),
  ).rejects.toThrow();
  await intent.recover();
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(intent.ambiguous).toBe(false);
});
it("excluye envíos simultáneos antes de actualizar React", async () => {
  let done!: (value: { id: string }) => void;
  const send = vi.fn(
    () =>
      new Promise<{ id: string }>((resolve) => {
        done = resolve;
      }),
  );
  const intent = new IntentController(send);
  const one = intent.submit({ resourceId: "one", action: "refresh" });
  await expect(
    intent.submit({ resourceId: "one", action: "refresh" }),
  ).rejects.toThrow();
  done({ id: "ok" });
  await one;
  expect(send).toHaveBeenCalledTimes(1);
});
it("HTTP no sigue redirects, usa cookies del mismo origen y respeta Retry-After", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response("{}", { status: 429, headers: { "Retry-After": "90" } }),
    );
  await expect(
    createHttpProvider(fetcher).getResources(),
  ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 90 });
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("202 conserva estado terminal devuelto y no deduce éxito del código", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ state: "uncertain" }), { status: 202 }),
    );
  expect(
    await createHttpProvider(fetcher).createOperation(
      { resourceId: "one", action: "stop", confirmed: true },
      "same-key",
    ),
  ).toMatchObject({ state: "uncertain" });
  expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
    "Idempotency-Key": "same-key",
  });
});
it("conserva intención original si una recuperación queda limitada por429", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(
      new ProviderError({ kind: "network", ambiguous: true, message: "corte" }),
    )
    .mockRejectedValueOnce(
      new ProviderError({
        kind: "http",
        status: 429,
        retryAfterSeconds: 45,
        message: "esperar",
      }),
    )
    .mockResolvedValue({ id: "original" });
  const intent = new IntentController(send);
  await expect(
    intent.submit({ resourceId: "one", action: "stop", confirmed: true }),
  ).rejects.toThrow();
  await expect(intent.recover()).rejects.toMatchObject({ status: 429 });
  expect(intent.ambiguous).toBe(true);
  await intent.recover();
  expect(send.mock.calls[2]).toEqual(send.mock.calls[0]);
});
