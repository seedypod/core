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
      // API_TARGET=http://seedypod.local points the UI at a real unit instead of a local core.
      '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: !!process.env.API_TARGET },
    },
  },
})
