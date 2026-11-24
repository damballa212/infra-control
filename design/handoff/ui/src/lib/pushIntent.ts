/** Solo una preferencia de exclusión del navegador: nunca IDs, claves ni valores privados. */
const KEY = "infra-control:push-opt-out";
let fallback: boolean | undefined;
export function pushDisabled(): boolean {
  try { return localStorage.getItem(KEY) === "1" || fallback === true; }
  catch { return fallback ?? true; }
}
export function setPushDisabled(disabled: boolean): void {
  fallback = disabled;
  try { if (disabled) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); }
  catch { /* Sin almacenamiento, la siguiente carga falla cerrada; no registra automáticamente. */ }
}
