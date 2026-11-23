import React from "react";
import ReactDOM from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "@blueprintjs/select/lib/css/blueprint-select.css";
import "../styles.css";
import "../ui/ui.css";
import "./studio.css";
import StudioApp from "./StudioApp";
import { initTheme } from "../theme";
import { initDensity } from "../ui/prefs";

initTheme();
initDensity();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StudioApp />
  </React.StrictMode>,
);
