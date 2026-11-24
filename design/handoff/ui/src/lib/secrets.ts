// Presentación humana de las solicitudes de secretos. Ningún dato aquí contiene valores.
import type { SecretDestination, SecretRequest, SecretRequestState, SecretScope } from "../contract.ts";
import type { GlyphName, Tone } from "./status.ts";

export const STATE_VIEWS: Readonly<Record<SecretRequestState, { label: string; tone: Tone; glyph: GlyphName }>> = {
  pending: { label: "Espera tu decisión", tone: "warn", glyph: "bang" },
  approved: { label: "Aprobada, por entregar", tone: "busy", glyph: "half" },
  delivered: { label: "Entregada", tone: "on", glyph: "check" },
  denied: { label: "Denegada", tone: "off", glyph: "cross" },
  expired: { label: "Venció", tone: "unk", glyph: "question" },
  failed: { label: "Falló la entrega", tone: "bad", glyph: "cross" },
};

export const SCOPE_OPTIONS: ReadonlyArray<{ value: SecretScope; label: string; hint: string }> = [
  { value: "once", label: "Solo esta vez", hint: "La próxima petición vuelve a pedirte permiso." },
  { value: "machine_project", label: "Este equipo", hint: "Mientras no lo revoques, este agente recibe esta variable en este equipo y proyecto sin preguntarte." },
  { value: "always", label: "Siempre", hint: "Mientras no lo revoques, este agente la recibe en cualquier equipo para este proyecto sin preguntarte." },
];

const EVENT_LABELS: Readonly<Record<string, string>> = {
  created: "Solicitada",
  approved: "Aprobada",
  auto_approved: "Aprobada por un permiso permanente",
  denied: "Denegada",
  delivered: "Entregada",
  failed: "Falló la entrega",
  expired: "Venció",
  grant_revoked: "Permiso revocado",
};

export const eventLabel = (event: string): string => EVENT_LABELS[event] ?? "Evento sin descripción";

export function destinationLabel(destination: SecretDestination): string {
  return destination.kind === "dotenv" ? `Archivo ${destination.path}` : "Variable de entorno de un proceso";
}

export function scopeLabel(scope: SecretScope | null): string {
  return SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? "—";
}

export function projectLabel(request: Pick<SecretRequest, "project" | "environment">): string {
  return request.environment ? `${request.project} · ${request.environment}` : request.project;
}

/** Pendientes primero, luego lo más reciente. */
export function sortRequests(requests: readonly SecretRequest[]): SecretRequest[] {
  return [...requests].sort((a, b) => {
    const pending = Number(b.state === "pending") - Number(a.state === "pending");
    return pending !== 0 ? pending : Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

export function pendingCount(requests: readonly SecretRequest[] | undefined): number {
  return requests?.filter((request) => request.state === "pending").length ?? 0;
}
