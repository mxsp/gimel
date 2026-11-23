import React from "react";
import ReactDOM from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "@blueprintjs/select/lib/css/blueprint-select.css";
import "../blueprint-gimel.css";
import "../styles.css";
import "../ui/ui.css";
import "../vercel-polish.css";
import "../ui/finish.css";
import "./twin-app.css";
import TwinApp from "./TwinApp";
import { initTheme } from "../theme";
import { initDensity } from "../ui/prefs";
import { initDetail } from "../ui/detail";

initTheme();
initDensity();
initDetail();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TwinApp />
  </React.StrictMode>,
);
