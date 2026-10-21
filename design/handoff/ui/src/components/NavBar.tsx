import { Link, type Route } from "../lib/router.tsx";
import { Glyph } from "./Glyph.tsx";
import { Hermes } from "./Hermes.tsx";
import type { GlyphName } from "../lib/status.ts";
const items: {
  name: Route["name"];
  label: string;
  glyph: GlyphName;
  wide?: boolean;
}[] = [
  { name: "control", label: "Inicio", glyph: "bolt" },
  { name: "search", label: "Equipos", glyph: "half" },
  { name: "activity", label: "Actividad", glyph: "ellipsis" },
  { name: "costs", label: "Costes", glyph: "ring" },
  { name: "settings", label: "Ajustes", glyph: "square", wide: true },
];
export function NavBar({ route }: { route: Route }) {
  const active =
    route.name === "resource"
      ? "control"
      : route.name === "operation"
        ? "activity"
        : ["password", "install", "agents"].includes(route.name)
          ? "settings"
          : route.name;
  return (
    <nav className="nav on-night" aria-label="Navegación principal">
      <Link to="/" className="nav__brand">
        <Hermes mood="calm" size={40} />
        <span className="nav__brand-title t-h3">
          Infra
          <br />
          Control
        </span>
      </Link>
      {items.map((item) => (
        <Link
          key={item.name}
          to={{ name: item.name } as Route}
          className={`nav__item ${item.wide ? "nav__item--wide" : ""}`}
          aria-current={active === item.name ? "page" : undefined}
        >
          <Glyph name={item.glyph} />
          {item.label}
        </Link>
      ))}
      <div className="nav__spacer" />
      <p className="nav__foot t-small">Admin · sesión 7 días</p>
    </nav>
  );
}
