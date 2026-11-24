import type { Resource } from "../contract.ts";
import type { MacMode } from "../components/HomeSprites.tsx";
import { formatAgo } from "./format.ts";
import type { GlyphName, Tone } from "./status.ts";

export interface MacCardView {
  mode: MacMode;
  /** Estado a la vista; null cuando no hay agente (no se afirma nada de la Mac). */
  pill: { tone: Tone; glyph: GlyphName; label: string } | null;
  caption: string;
  linked: boolean;
}

/** La Mac solo informa presencia por su agente: nunca se infiere desde el navegador ni se afirma que esté apagada. */
export function macCardView(mac: Pick<Resource, "state" | "observedAt" | "note">, now: number): MacCardView {
  switch (mac.state) {
    case "running":
      return {
        mode: "on",
        pill: { tone: "on", glyph: "dot", label: `En línea · aviso ${formatAgo(mac.observedAt, now)}` },
        caption: "Solo lectura: el panel no apaga ni despierta la Mac.",
        linked: true,
      };
    case "asleep":
      return {
        mode: "asleep",
        pill: { tone: "none", glyph: "ring", label: "En reposo anunciado" },
        caption: "La Mac avisó que entraría en reposo. No confirma que la suspensión se completara.",
        linked: true,
      };
    case "unreachable":
      return {
        mode: "nosignal",
        pill: { tone: "unk", glyph: "question", label: "Sin señal" },
        caption: "Dejó de avisar. No confirma que esté apagada: puede estar en reposo o sin red.",
        linked: true,
      };
    case "unconfigured":
      return {
        mode: "unlinked",
        pill: null,
        caption: "Sin agente: el panel no recibe avisos de ella.",
        linked: false,
      };
    default:
      return {
        mode: "nosignal",
        pill: { tone: "unk", glyph: "question", label: "Sin datos" },
        caption: mac.note ?? "Todavía no llegó el primer aviso del agente.",
        linked: true,
      };
  }
}
