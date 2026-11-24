import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import "../../tokens/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/sprites.css";
import "./styles/home-sprites.css";
import "./styles/motion.css";
import "./styles/layout.css";
import "./styles/v2.css";
import "./styles/area-hoy.css";
import "./styles/area-login.css";
import "./styles/area-inventory.css";
import "./styles/area-activity.css";
import "./styles/area-costs.css";
import "./styles/area-agents.css";
import "./styles/area-me.css";
// En la app instalada, mantener pulsado un enlace (Android) abre «abrir en pestaña nueva» y rompe la PWA:
// se suprime el menú contextual sobre controles, sin tocar campos de texto.
if (window.matchMedia?.("(display-mode: standalone)").matches) {
  document.addEventListener("contextmenu", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, [role=button], .nav") && !target.closest("input, textarea, [contenteditable=true]")) event.preventDefault();
  });
}
const root = document.getElementById("root");
if (!root) throw new Error("Falta root");
createRoot(root).render(
  <div className="app">
    <App />
  </div>,
);
