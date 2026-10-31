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
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
})
