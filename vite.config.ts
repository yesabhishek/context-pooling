import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/web",
  publicDir: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/web", import.meta.url))
    }
  },
  build: {
    outDir: "../../dist-web",
    emptyOutDir: true
  }
});
