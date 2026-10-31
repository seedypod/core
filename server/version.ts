import { existsSync, readFileSync } from 'node:fs'

/** `.git-info` is pinned by CI at build time (see .github/workflows/release.yml). */
export function readVersion(): string {
  try {
    if (existsSync('.git-info')) {
      const info = JSON.parse(readFileSync('.git-info', 'utf8')) as { branch?: string, commitHash?: string }
      return `${info.branch ?? 'unknown'}@${info.commitHash ?? '0000000'}`
    }
  }
  catch {
    // fall through
  }
  return 'dev'
}
