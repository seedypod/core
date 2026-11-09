import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEventBus, type CoreEvent } from '../../lib/eventBus'
import { isRunning, UpdateClient, updateCommand, UpdateRefused } from '../client'

let dir: string
let work: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'update-client-'))
  work = join(dir, 'work')
  mkdirSync(work)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const CHECK = {
  ok: true,
  channel: 'dev',
  installed: { version: 'dev@aaaaaaa', commit: 'aaaaaaa', branch: 'dev', tag: null },
  available: { tag: 'dev-latest', commit: 'b'.repeat(40), name: 'Dev (latest)', publishedAt: '2026-11-08T00:00:00Z', url: null },
  updateAvailable: true,
  problem: null,
}

/** A stand-in helper: records its arguments, then answers as told. */
function helper(answer: object, exit = 0) {
  const script = join(dir, 'helper.mjs')
  writeFileSync(script, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(join(dir, 'args.log'))}, process.argv.slice(2).join(' ') + '\\n')
console.log('progress on stdout')
console.log(${JSON.stringify(JSON.stringify(answer))})
process.exit(${exit})
`)
  return [process.execPath, script]
}

const args = () => readFileSync(join(dir, 'args.log'), 'utf8').trim().split('\n')
const status = (state: string, at = new Date().toISOString(), extra: object = {}) => writeFileSync(join(work, 'status.json'), JSON.stringify({ op: 'update', state, at, ...extra }))

describe('UpdateClient', () => {
  it('checks, sets the channel and starts with the fixed arguments sudoers allows', async () => {
    const c = new UpdateClient({ command: helper(CHECK), workDir: work, version: 'dev@aaaaaaa' })
    expect(await c.check()).toEqual({ channel: 'dev', installed: CHECK.installed, available: CHECK.available, updateAvailable: true, problem: null })
    expect(await c.setChannel('stable')).toBe('stable')
    status('queued')
    expect(await c.start()).toMatchObject({ state: 'queued' })
    expect(c.watching).toBe(true)
    c.stop()
    expect(args()).toEqual(['--check', '--channel stable', '--start'])
  })

  it('refuses a channel that is neither, without running the helper', async () => {
    const c = new UpdateClient({ command: helper({ ok: true }), workDir: work, version: 'dev' })
    await expect(c.setChannel('nightly' as 'dev')).rejects.toMatchObject({ code: 'usage' })
  })

  it('passes on a refusal with its code and message', async () => {
    const c = new UpdateClient({ command: helper({ ok: false, code: 'checksum', error: 'seedypod-core.tar.gz doesn\'t match' }, 4), workDir: work, version: 'dev' })
    const err = await c.start().catch(e => e as UpdateRefused)
    expect(err).toBeInstanceOf(UpdateRefused)
    expect(err).toMatchObject({ code: 'checksum', message: 'seedypod-core.tar.gz doesn\'t match' })
    expect(c.watching).toBe(false)
  })

  it('reports a helper with no answer as a failure with its stderr, and a missing helper as unavailable', async () => {
    const script = join(dir, 'broken.mjs')
    writeFileSync(script, 'console.error("sudo: a password is required"); process.exit(1)')
    const c = new UpdateClient({ command: [process.execPath, script], workDir: work, version: 'dev' })
    await expect(c.check()).rejects.toMatchObject({ code: 'failed', message: 'sudo: a password is required' })
    const none = new UpdateClient({ command: null, workDir: work, version: 'dev' })
    expect(none.available).toBe(false)
    await expect(none.check()).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('reads the channel, the last run, its log and the release tag from the helper\'s files', () => {
    const c = new UpdateClient({ command: helper({ ok: true }), workDir: work, version: 'main@bbbbbbb' })
    expect(c.info()).toEqual({ available: true, channel: 'stable', tag: null, status: null, log: [] })
    expect(new UpdateClient({ command: null, workDir: work, version: 'dev@aaaaaaa' }).channel()).toBe('dev')
    writeFileSync(join(work, 'channel'), 'dev\n')
    status('done', '2026-11-08T01:00:00.000Z', { to: { tag: 'v1.2.0', commit: 'b'.repeat(40) } })
    writeFileSync(join(work, 'update.log'), 'one\ntwo\n')
    writeFileSync(join(work, 'installed.json'), JSON.stringify({ tag: 'v1.2.0', version: 'main@bbbbbbb' }))
    expect(c.info()).toMatchObject({ channel: 'dev', tag: 'v1.2.0', status: { state: 'done', to: { tag: 'v1.2.0' } }, log: ['one', 'two'] })
    // A tag from an earlier install doesn't name the build now running.
    expect(new UpdateClient({ command: null, workDir: work, version: 'dev@ccccccc' }).info().tag).toBeNull()
    // Junk in the channel or status file is ignored.
    writeFileSync(join(work, 'channel'), 'nightly\n')
    writeFileSync(join(work, 'status.json'), '{"state":"exploded"}')
    expect(c.info()).toMatchObject({ channel: 'stable', status: null })
    writeFileSync(join(work, 'status.json'), 'not json')
    expect(c.status()).toBeNull()
  })

  it('turns new status and log lines into update events, and stops once the run is over', () => {
    const events = createEventBus()
    const seen: CoreEvent[] = []
    events.subscribe(e => seen.push(e))
    status('downloading', '2026-11-08T01:00:00.000Z')
    writeFileSync(join(work, 'update.log'), 'downloading seedypod-core.tar.gz\n')
    // A core that starts mid-update follows it.
    const c = new UpdateClient({ command: null, workDir: work, version: 'dev', events, pollMs: 60_000 })
    expect(c.watching).toBe(true)
    c.tick()
    c.tick()
    appendFileSync(join(work, 'update.log'), 'seedypod-core.tar.gz: 10 bytes, sha256 abc… matches\n')
    status('stopping', '2026-11-08T01:00:01.000Z')
    c.tick()
    status('done', '2026-11-08T01:00:09.000Z')
    c.tick()
    expect(seen).toEqual([
      { kind: 'update', state: 'downloading', lines: ['downloading seedypod-core.tar.gz'] },
      { kind: 'update', state: 'stopping', lines: ['seedypod-core.tar.gz: 10 bytes, sha256 abc… matches'] },
      { kind: 'update', state: 'done', lines: [] },
    ])
    expect(c.watching).toBe(false)
  })

  it('starts the log over when a new run truncates it', () => {
    const events = createEventBus()
    const seen: CoreEvent[] = []
    events.subscribe(e => seen.push(e))
    status('downloading', '2026-11-08T01:00:00.000Z')
    writeFileSync(join(work, 'update.log'), 'a long line from the last run\n')
    const c = new UpdateClient({ command: null, workDir: work, version: 'dev', events, pollMs: 60_000 })
    c.tick()
    writeFileSync(join(work, 'update.log'), 'new\n')
    status('verifying', '2026-11-08T02:00:00.000Z')
    c.tick()
    c.stop()
    expect(seen.at(-1)).toEqual({ kind: 'update', state: 'verifying', lines: ['new'] })
  })

  it('knows which states are a run in progress', () => {
    expect(isRunning('health')).toBe(true)
    expect(isRunning('rolling-back')).toBe(true)
    expect(isRunning('rolled-back')).toBe(false)
    expect(isRunning(undefined)).toBe(false)
  })
})

describe('updateCommand', () => {
  it('takes an override, and otherwise sudo and the installed helper when it is there', () => {
    expect(updateCommand({ SEEDYPOD_UPDATE_CMD: '["node","scripts/seedypod-update.cjs"]' })).toEqual(['node', 'scripts/seedypod-update.cjs'])
    expect(updateCommand({})).toBeNull()
  })
})
