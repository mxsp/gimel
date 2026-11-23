import React from "react";
import ReactDOM from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import "../tokens.css";
import "../blueprint-gimel.css";
import "../styles.css";
import "./voice.css";
import VoiceApp from "./VoiceApp";

const dark = document.documentElement.dataset.theme === "dark";
document.body.classList.toggle("bp5-dark", dark);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <VoiceApp />
  </React.StrictMode>,
);
