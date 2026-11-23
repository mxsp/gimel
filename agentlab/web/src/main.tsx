import React from "react";
import ReactDOM from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import "./tokens.css";
import "./blueprint-gimel.css";
import "./styles.css";
import App from "./App";

const dark = document.documentElement.dataset.theme === "dark";
document.body.classList.toggle("bp5-dark", dark);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
