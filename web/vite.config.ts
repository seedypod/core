import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const webRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: webRoot,
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true, routesDirectory: `${webRoot}src/routes`, generatedRouteTree: `${webRoot}src/routeTree.gen.ts` }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': repoRoot },
  },
  build: {
    outDir: `${webRoot}dist`,
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // API_TARGET=http://seedypod.local:3000 points the UI at a real unit instead of a local core. A unit with an
      // API key wants it on every request: API_KEY (read here, in Node; never VITE_-prefixed, so never in the bundle)
      // goes on as X-API-Key.
      '/api': {
        target: process.env.API_TARGET || 'http://127.0.0.1:3000',
        changeOrigin: !!process.env.API_TARGET,
        ...(process.env.API_KEY ? { headers: { 'x-api-key': process.env.API_KEY } } : {}),
      },
    },
  },
})
