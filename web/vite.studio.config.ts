import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Der Assistent (Seitenleiste) ist ein Baustein aus agentlab/web/src: ein Chat-Code für /lab,
// Portal und Studio. Dessen eigene node_modules dürfen React und Blueprint nicht doppeln.
const agentlab = fileURLToPath(new URL("../agentlab/web/src", import.meta.url));

// Twin Studio: dieselben Bausteine wie das Portal (src/components/twin), eigene
// Oberfläche. Der Bau landet in gimel/studio/dist und wird unter /studio
// ausgeliefert — vom Portal selbst und von `gimel studio` (Port 8009).
export default defineConfig({
  base: "/studio/",
  plugins: [react()],
  resolve: {
    alias: { "@agentlab": agentlab },
    dedupe: ["react", "react-dom", "@blueprintjs/core", "@blueprintjs/icons"],
  },
  server: {
    port: 5175,
    proxy: { "/api": { target: "http://127.0.0.1:8040", changeOrigin: true } },
  },
  build: {
    outDir: "../gimel/studio/dist",
    emptyOutDir: true,
    // Die Sortierzelle wohnt seit 2026-11-08 im Portal (Roboter → Arme & Zellen).
    rollupOptions: { input: ["studio.html"] },
  },
});
