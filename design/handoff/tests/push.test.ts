import { describe, expect, it, vi } from "vitest";
import { createHttpProvider } from "../integration/httpProvider.ts";
import { applicationServerKey } from "../ui/src/lib/push.ts";

describe("applicationServerKey", () => {
  it("convierte base64url sin relleno en los bytes de la clave", () => {
    // 65 bytes: 0x04 seguido de 64 ceros, como una clave P-256 sin comprimir.
    const raw = String.fromCharCode(4, ...new Array<number>(64).fill(0));
    const encoded = btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const bytes = applicationServerKey(encoded);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
    expect(bytes[64]).toBe(0);
  });

  it("entiende los caracteres - y _ de base64url", () => {
    expect(Array.from(applicationServerKey("-_8"))).toEqual([251, 255]);
  });
});

describe("proveedor HTTP de avisos", () => {
  const respond = (body: unknown = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it("lee la configuración sin enviar cuerpo", async () => {
    const fetcher = respond({ enabled: true, vapidPublicKey: "k" });
    const config = await createHttpProvider(fetcher).getPushConfig();
    expect(config.enabled).toBe(true);
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/push/config");
    expect(init.method).toBe("GET");
  });

  it("registra la suscripción, actualiza preferencias con PUT y revoca con DELETE", async () => {
    const fetcher = respond({ id: "d1" });
    const provider = createHttpProvider(fetcher);
    await provider.registerPush({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: "a", auth: "b" } });
    await provider.updatePushPreferences("d1", { operations: true, devices: false, router: true, infrastructure: true, budgets: true, secrets: true, secretDeliveries: true });
    await provider.removePush("d1");
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([path, init]) => `${init.method} ${path}`)).toEqual([
      "POST /api/push/subscriptions",
      "PUT /api/push/subscriptions/d1/preferences",
      "DELETE /api/push/subscriptions/d1",
    ]);
  });

  it("muestra el motivo redactado por el servidor cuando falla un aviso", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "Espera un minuto antes de enviar otra prueba de aviso." }), { status: 429 }));
    await expect(createHttpProvider(fetcher).testPush("d1")).rejects.toThrow("Espera un minuto");
  });
});
