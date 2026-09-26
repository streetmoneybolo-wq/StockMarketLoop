import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // relative asset URLs: the same build serves stockmarketloop-loop-kick.onrender.com
  // AND Discord's activity proxy at https://{app}.discordsays.com/.proxy/loop-kick/
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
