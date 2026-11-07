// Bundles core and its dependencies into server/dist. Node spends most of a cold
// start resolving node_modules, not running them, so a bundle is what makes a Pi
// Zero start quickly. `await import()` becomes a chunk that loads on first use.
import { rmSync } from 'node:fs'
import { build } from 'esbuild'

// Chunks are named by content, so a build would otherwise leave the last one's behind.
rmSync('server/dist', { recursive: true, force: true })

await build({
  entryPoints: ['server/index.ts', 'src/vision/visionWorker.ts', 'src/db/inspectWorker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  splitting: true,
  sourcemap: true,
  outdir: 'server/dist',
  // Flat, because sqlite.ts and index.ts find migrations and workers from their own URL.
  entryNames: '[name]',
  // A native addon, and a large stack that only loads if HomeKit is turned on.
  external: ['better-sqlite3', 'hap-nodejs'],
  // Bundled CommonJS packages still call require() for Node builtins.
  banner: { js: 'import { createRequire as __require_of } from \'node:module\'; const require = __require_of(import.meta.url);' },
  logLevel: 'warning',
})
