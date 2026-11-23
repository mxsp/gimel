import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Der Assistent (Seitenleiste) ist ein Baustein aus agentlab/web/src: ein Chat-Code für /lab,
// Portal und Studio. Dessen eigene node_modules dürfen React und Blueprint nicht doppeln.
const agentlab = fileURLToPath(new URL("../agentlab/web/src", import.meta.url));

// Das gebaute Portal landet direkt dort, wo FastAPI es ausliefert
// (gimel/webapp/dist — Route /app). Der Dev-Server proxyt /api
// zum Backend auf 8001, damit `npm run dev` ohne Deployment testet.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  resolve: {
    alias: { "@agentlab": agentlab },
    dedupe: ["react", "react-dom", "@blueprintjs/core", "@blueprintjs/icons"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8001", changeOrigin: true },
    },
  },
  build: {
    outDir: "../gimel/webapp/dist",
    emptyOutDir: true,
  },
});
