# Testing

| Layer | Tool | Where | Run |
|---|---|---|---|
| TS unit | Vitest (node env by default; add `// @vitest-environment jsdom` for components) | `src/<area>/tests/*.test.ts` | `pnpm test` |
| TS contract | Vitest | `src/server/tests/openapi.contract.test.ts`, `src/hardware/tests/contract.fixtures.test.ts` | `pnpm test` |
| Browser | Node smoke now; Playwright `*.e2e.ts` in Phase 4.3 | `tests/browser/` | `pnpm build && pnpm test:browser` |
| Rust | cargo test (+ llvm-cov in CI) | in-module `#[cfg(test)]` | `pnpm hal:test` |
| Mutation | Stryker, weekly + `mutation-test` label | `stryker.config.mjs` | `pnpm test:mutation` |
| Knowledge | OKF validator | `knowledge/` | `python scripts/validate_knowledge.py` |

Coverage gates live in Codecov (`codecov.yml`), flags `javascript` and `rust`.
