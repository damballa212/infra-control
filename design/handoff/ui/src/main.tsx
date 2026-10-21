import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import "../../tokens/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/feedback.css";
import "./styles/sprites.css";
import "./styles/home-sprites.css";
import "./styles/motion.css";
import "./styles/layout.css";
import "./styles/screens.css";
const root = document.getElementById("root");
if (!root) throw new Error("Falta root");
createRoot(root).render(
  <div className="app">
    <App />
  </div>,
);
