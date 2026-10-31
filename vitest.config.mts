import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@': root },
  },
  test: {
    globals: true,
    environment: 'node',
    projects: undefined,
    environmentOptions: {},
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'tests/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'tests/browser/**', 'hal/**'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: process.env.VITEST_JUNIT_OUTPUT || 'test-results/junit.xml' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}', 'server/**/*.ts', 'web/src/**/*.{ts,tsx}', 'lib/**/*.ts'],
      exclude: ['**/tests/**', '**/*.test.{ts,tsx}', '**/*.d.ts', 'web/src/routeTree.gen.ts', 'web/src/main.tsx'],
    },
  },
})
