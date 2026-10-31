import { default as eslint } from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import pluginReact from 'eslint-plugin-react'
import pluginReactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
  },
  { settings: { react: { version: 'detect' } } },
  eslint.configs.recommended,
  stylistic.configs.recommended,
  tseslint.configs.strict,
  pluginReact.configs.flat.recommended,
  pluginReact.configs.flat['jsx-runtime'],
  pluginReactHooks.configs.flat.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.mts', '**/*.cts'],
    languageOptions: { parser: tseslint.parser },
  },

  globalIgnores([
    '.claude/**',
    '.codex/**',
    'coverage/**',
    'dist/**',
    'web/dist/**',
    'server/dist/**',
    'hal/**',
    'web/src/routeTree.gen.ts',
    'reports/**',
    '.stryker-tmp/**',
  ]),

  {
    rules: {
      '@stylistic/comma-dangle': ['error', 'only-multiline'],
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxEOF: 1 }],
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
])
