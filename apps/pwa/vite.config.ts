import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/")) {
            return "vendor-react";
          }
          if (id.includes("@stellar/") || id.includes("stellar-base") || id.includes("js-xdr")) {
            return "vendor-stellar";
          }
          if (id.includes("@noble/") || id.includes("@scure/") || id.includes("hash-wasm")) {
            return "vendor-crypto";
          }
          return undefined;
        },
      },
    },
  },
});
