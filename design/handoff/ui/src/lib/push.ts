import type { PushSubscriptionInput } from "../contract.ts";

/** Por qué este navegador no puede recibir avisos (o `null` si puede). */
export type PushBlocker = "unsupported" | "denied";

export function pushBlocker(): PushBlocker | null {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  )
    return "unsupported";
  return Notification.permission === "denied" ? "denied" : null;
}

/** La clave VAPID pública viaja en base64url; pushManager.subscribe la quiere como bytes. */
export function applicationServerKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1)
    bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** El service worker solo existe en la build de producción; sin él no hay avisos y `ready` nunca resolvería. */
async function registration(): Promise<ServiceWorkerRegistration> {
  const found = await navigator.serviceWorker.getRegistration("/");
  if (!found) throw new Error("no-service-worker");
  return found;
}

/** Suscripción vigente de este navegador, sin pedir permiso ni crear nada. */
export async function currentSubscription(): Promise<PushSubscriptionInput | null> {
  const subscription = await (await registration()).pushManager.getSubscription();
  return subscription ? toInput(subscription) : null;
}

/** Pide permiso (solo desde un gesto de la persona) y crea la suscripción. */
export async function subscribeThisDevice(
  vapidPublicKey: string,
): Promise<PushSubscriptionInput> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("permission-denied");
  const subscription = await (await registration()).pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(vapidPublicKey),
  });
  return toInput(subscription);
}

export async function unsubscribeThisDevice(): Promise<void> {
  const subscription = await (await registration()).pushManager.getSubscription();
  await subscription?.unsubscribe();
}

function toInput(subscription: PushSubscription): PushSubscriptionInput {
  const json = subscription.toJSON();
  const keys = json.keys;
  if (!json.endpoint || !keys?.p256dh || !keys.auth)
    throw new Error("incomplete-subscription");
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}
