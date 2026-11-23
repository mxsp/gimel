import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const agentlab = fileURLToPath(new URL("../agentlab/web/src", import.meta.url));

// Digitaler Grundriss als eigenständige App (wie Twin Studio & Agent Lab).
// Der Bau landet in gimel/twin/dist und wird unter /twin ausgeliefert —
// sowohl vom Portal als auch von `gimel twin` (Port 8010).
export default defineConfig({
  base: "/twin/",
  plugins: [react()],
  resolve: {
    alias: { "@agentlab": agentlab },
    dedupe: ["react", "react-dom", "@blueprintjs/core", "@blueprintjs/icons"],
  },
  server: {
    port: 5176,
    proxy: { "/api": { target: "http://127.0.0.1:8040", changeOrigin: true } },
  },
  build: {
    outDir: "../gimel/twin/dist",
    emptyOutDir: true,
    rollupOptions: { input: ["twin.html"] },
  },
});
