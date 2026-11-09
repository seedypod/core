/**
 * Node-only: finds and reads the shipped pod-state weights (#185). The file is
 * `models/pod-state.json` at the root of the release, next to `server/` and
 * `src/`, so the release tarball and the web updater (ADR-0026) carry it with
 * the code. POD_STATE_MODEL points somewhere else; set it to an empty string to
 * run without the model.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The places the shipped file can be: two levels up from src/vision (tsx) and from server/dist (the bundle), or the working directory. */
export function podStateCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.POD_STATE_MODEL !== undefined) return env.POD_STATE_MODEL ? [env.POD_STATE_MODEL] : []
  return [resolve(here, '../../models/pod-state.json'), resolve(process.cwd(), 'models/pod-state.json')]
}

/** The weights file's text, or null with the reason it isn't there. */
export function readPodStateModel(candidates = podStateCandidates()): { text: string | null, missing?: string } {
  const path = candidates.find(p => existsSync(p))
  if (!path) return { text: null, missing: candidates.length ? `No weights file at ${candidates[0]}, so this analyser is off.` : 'Turned off with POD_STATE_MODEL="".' }
  try {
    return { text: readFileSync(path, 'utf8') }
  }
  catch (e) {
    return { text: null, missing: `The weights file ${path} could not be read: ${(e as Error).message}` }
  }
}
