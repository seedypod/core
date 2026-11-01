/**
 * BM25F ranking for a small in-memory corpus (the command palette's pages,
 * settings, pods and rules). Each field has its own weight and length
 * normalisation; weighted term frequencies are summed across fields and
 * saturated once per term. The last query token also matches as a prefix so
 * results update while typing. Pure: no DOM, no I/O. Ported from
 * sleepypod/core (src/lib/bm25.ts).
 */

export interface Bm25Field {
  /** Multiplier on this field's term frequency (title > description). */
  weight: number
  /** Length normalisation, 0 (none) to 1 (full). Default 0.75. */
  b?: number
}

export interface Bm25Options {
  /** Term-frequency saturation. Default 1.2. */
  k1?: number
  /** Score multiplier for a prefix expansion that isn't the exact token. Default 0.9. */
  prefixWeight?: number
}

export interface Bm25Hit {
  /** Position of the document in the array the index was built from. */
  index: number
  score: number
}

export interface Bm25Index {
  search: (query: string, limit?: number) => Bm25Hit[]
}

/**
 * Lowercase, strip diacritics, split on anything that isn't a letter or digit.
 * A hyphenated or dotted word also yields its joined form, so "Wi-Fi" matches
 * "wifi" and "auto-off" matches "autooff".
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const folded = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  for (const chunk of folded.split(/\s+/)) {
    const parts = chunk.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    out.push(...parts)
    if (parts.length > 1) out.push(parts.join(''))
  }
  return out
}

interface FieldStats {
  tf: Map<string, number>
  length: number
}

export function createBm25Index<F extends string>(
  docs: ReadonlyArray<Readonly<Record<NoInfer<F>, string>> & { boost?: number }>,
  fields: Readonly<Record<F, Bm25Field>>,
  { k1 = 1.2, prefixWeight = 0.9 }: Bm25Options = {},
): Bm25Index {
  const names = Object.keys(fields) as F[]
  const stats: Array<Record<F, FieldStats>> = docs.map((doc) => {
    const row = {} as Record<F, FieldStats>
    for (const f of names) {
      const tokens = tokenize(doc[f] ?? '')
      const tf = new Map<string, number>()
      for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1)
      row[f] = { tf, length: tokens.length }
    }
    return row
  })

  const avg = {} as Record<F, number>
  for (const f of names) {
    avg[f] = docs.length ? stats.reduce((sum, row) => sum + row[f].length, 0) / docs.length : 0
  }

  const df = new Map<string, number>()
  for (const row of stats) {
    const seen = new Set<string>()
    for (const f of names) for (const term of row[f].tf.keys()) seen.add(term)
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1)
  }
  // Sorted so prefix expansion (and therefore scoring order) is deterministic.
  const vocabulary = [...df.keys()].sort()
  const n = docs.length

  const termScore = (term: string, d: number): number => {
    let weighted = 0
    for (const f of names) {
      const { tf, length } = stats[d][f]
      const count = tf.get(term)
      if (!count) continue
      const b = fields[f].b ?? 0.75
      const norm = avg[f] > 0 ? 1 - b + b * (length / avg[f]) : 1
      weighted += (fields[f].weight * count) / norm
    }
    if (weighted === 0) return 0
    const freq = df.get(term) ?? 0
    const idf = Math.log(1 + (n - freq + 0.5) / (freq + 0.5))
    return (idf * weighted * (k1 + 1)) / (k1 + weighted)
  }

  return {
    search(query, limit) {
      const tokens = tokenize(query)
      if (tokens.length === 0) return []
      const last = tokens[tokens.length - 1]

      // One group per distinct query token; a document scores the best
      // expansion within each group, summed across groups.
      const groups: Array<Array<{ term: string, weight: number }>> = []
      for (const tok of new Set(tokens)) {
        if (tok === last) {
          const expansions = vocabulary
            .filter(v => v.startsWith(tok))
            .map(v => ({ term: v, weight: v === tok ? 1 : prefixWeight }))
          if (expansions.length) groups.push(expansions)
        }
        else if (df.has(tok)) {
          groups.push([{ term: tok, weight: 1 }])
        }
      }
      if (groups.length === 0) return []

      const hits: Bm25Hit[] = []
      for (let d = 0; d < n; d++) {
        let score = 0
        for (const group of groups) {
          let best = 0
          for (const { term, weight } of group) best = Math.max(best, weight * termScore(term, d))
          score += best
        }
        if (score > 0) hits.push({ index: d, score: score * (docs[d].boost ?? 1) })
      }
      // Ties keep the order the documents were indexed in.
      hits.sort((a, b) => b.score - a.score || a.index - b.index)
      return limit === undefined ? hits : hits.slice(0, limit)
    },
  }
}
