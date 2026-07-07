import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (!normalizedId.includes("node_modules")) {
            return undefined;
          }
          if (normalizedId.includes("monaco-editor") || normalizedId.includes("@monaco-editor")) {
            return "vendor-monaco";
          }
          if (normalizedId.includes("lucide-react")) {
            return "vendor-icons";
          }
          if (normalizedId.includes("react") || normalizedId.includes("react-dom") || normalizedId.includes("react-router")) {
            return "vendor-react";
          }
          if (normalizedId.includes("dayjs")) {
            return "vendor-dayjs";
          }
          if (normalizedId.includes("/yaml/")) {
            return "vendor-yaml";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 4173,
  },
});
