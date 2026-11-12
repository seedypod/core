#!/usr/bin/env node
// Refreshes the docs search snapshot bundled with the command palette (after
// sleepypod's sync-docs-index). Units often have no internet, so the palette
// searches this copy and only swaps in the live index when the browser can
// reach the docs site.
//
//   pnpm docs:sync-index                       # the live https://seedypod.github.io/search-index.json
//   pnpm docs:sync-index <site>/out/search-index.json   # a local docs site build
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DOCS_INDEX_URL, isDocsIndex } from '../src/components/Search/docsIndex.ts'

const out = fileURLToPath(new URL('../src/components/Search/docsIndex.json', import.meta.url))
const source = process.argv[2] ?? DOCS_INDEX_URL

let index
if (/^https?:\/\//.test(source)) {
  const res = await fetch(source, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    console.error(`${source} returned HTTP ${res.status}`)
    process.exit(1)
  }
  index = await res.json()
}
else {
  index = JSON.parse(readFileSync(source, 'utf8'))
}
if (!isDocsIndex(index)) {
  console.error(`${source} does not match the version 1 search index contract; snapshot left unchanged`)
  process.exit(1)
}

// Same-directory temp file + rename, so an interrupted run never leaves a truncated snapshot.
const tmp = `${out}.tmp`
writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`)
renameSync(tmp, out)
console.log(`Wrote ${index.pages.length} docs pages (generated ${index.generatedAt}) to ${out}`)
