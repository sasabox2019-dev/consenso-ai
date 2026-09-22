import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Builds straight into the Worker's asset directory so `npm run deploy`
  // ships API + UI as one unit (wrangler.jsonc assets.directory points here).
  build: { outDir: "../worker/public", emptyOutDir: true, sourcemap: false },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
