import React from "react";
import ReactDOM from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "@blueprintjs/select/lib/css/blueprint-select.css";
import "./styles.css";
import "./ui/ui.css";
import "./vercel-polish.css"; // UI-Pass 1 nach vercel-design.md; nur hier, nicht im Studio
import "./order-flow.css"; // Auftragsweg & Orderflow-Bausteine; nur Portal, nicht Studio
import "./ui/finish.css"; // Aufgabe 35, zweite Runde: eine Schrift, ein Tabellenkopf, ruhige Zahlen, Palette
import "./leitstand-ui.css"; // Kalender & Leitstand UI-Upgrade
import App from "./App";
import { initTheme } from "./theme";
import { initDensity } from "./ui/prefs";

initTheme();
initDensity();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

