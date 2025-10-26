import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default {
  // Ensure assets are referenced relatively so the app works from a subfolder
  base: "./",
  root: ".",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(rootDir, "index.html"),
        debugHarness: resolve(rootDir, "debug-harness.html")
      }
    }
  }
};
