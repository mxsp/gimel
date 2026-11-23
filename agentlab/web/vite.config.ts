import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "/lab/",
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/api": { target: "http://127.0.0.1:8008", changeOrigin: true },
    },
  },
  build: {
    outDir: "../webapp/dist",
    emptyOutDir: true,
    // Zwei Seiten aus einem Bau: das Labor (/lab) und Gimel Voice (/voice).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        voice: fileURLToPath(new URL("./voice.html", import.meta.url)),
      },
    },
  },
});
