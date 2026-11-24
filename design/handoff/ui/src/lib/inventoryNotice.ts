import type { Resource } from "../contract.ts";
import { ProviderError } from "../../../integration/provider.ts";
import type { BannerTone } from "../components/Banner.tsx";
import type { GlyphName } from "./status.ts";
export interface InventoryNotice {
  title: string;
  text: string;
  tone: BannerTone;
  glyph: GlyphName;
}
export function inventoryNotice({
  online,
  error,
  resources,
  now,
  loading,
}: {
  online: boolean;
  error: unknown;
  resources: Resource[];
  now: number;
  loading: boolean;
}): InventoryNotice | null {
  if (!online)
    return {
      title: "Sin conexión",
      text: "Ves la última lectura de esta sesión. No se envían órdenes ni se dejan en cola.",
      tone: "night",
      glyph: "bang",
    };
  if (error instanceof ProviderError && error.status === 429)
    return {
      title: "El panel pidió esperar",
      text: "Se respeta el tiempo de espera antes de volver a consultar.",
      tone: "warn",
      glyph: "half",
    };
  if (error)
    return {
      title: "El panel no responde",
      text: "No pudimos actualizar los equipos. La última observación sigue indicada en cada ficha.",
      tone: "bad",
      glyph: "cross",
    };
  if (loading && resources.length)
    return {
      title: "Comprobando al volver",
      text: "Actualizando la lista antes de habilitar las acciones.",
      tone: "info",
      glyph: "half",
    };
  if (
    resources.some(
      (r) => r.observedAt !== null && now - Date.parse(r.observedAt) > 180000,
    )
  )
    return {
      title: "Datos antiguos",
      text: "Comprueba la hora de observación. Una lectura antigua no demuestra que el equipo esté apagado.",
      tone: "warn",
      glyph: "bang",
    };
  if (resources.some((r) => r.kind === "service" && r.state === "unknown"))
    return {
      title: "Parte de la lista está sin datos",
      text: "Los demás equipos siguen disponibles. No se inventan estados de los proveedores que no respondieron.",
      tone: "info",
      glyph: "info",
    };
  return null;
}
