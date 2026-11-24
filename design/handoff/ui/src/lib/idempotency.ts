const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

/** Una clave por INTENCIÓN deliberada del usuario. No se genera una nueva por cada reintento automático. */
export function newIdempotencyKey(): string {
  const key =
    globalThis.crypto?.randomUUID?.() ??
    `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  if (!KEY_PATTERN.test(key)) throw new Error("Clave de idempotencia inválida");
  return key;
}

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}
