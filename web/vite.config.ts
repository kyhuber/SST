import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative paths so the static build works from a GitHub Pages project
  // subpath without knowing the repository name at build time.
  base: "./",
  build: { outDir: "dist" },
});
