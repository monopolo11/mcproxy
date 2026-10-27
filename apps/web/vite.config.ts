/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The daemon owns every non-asset route. In development the UI runs on its own
// origin and forwards API, OAuth callback, and MCP traffic to the daemon.
const daemon = "http://127.0.0.1:7433"
const proxied = { target: daemon, changeOrigin: true }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": proxied, "/oauth": proxied, "/mcps": proxied },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
