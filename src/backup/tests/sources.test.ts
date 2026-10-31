import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultMigrationsFolder, SqliteStore } from '../../store/sqlite'
import { backupPaths, nodeBackupSources, readSchema } from '../sources'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-sources-'))
})
afterEach(() => {
  try {
    chmodSync(join(dir, 'state'), 0o755)
  }
  catch {
    // this test made no state directory
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('backupPaths', () => {
  it('defaults to what the installers set up, and moves with SEEDYPOD_*', () => {
    expect(backupPaths({}, './data')).toEqual({ etcDir: '/etc/seedypod', stateDir: '/var/lib/seedypod', mosquittoPasswd: '/etc/mosquitto/seedypod.passwd', capturesDir: 'data/captures' })
    expect(backupPaths({ SEEDYPOD_ETC_DIR: '/x/etc', SEEDYPOD_STATE_DIR: '/x/state', SEEDYPOD_MOSQUITTO_PASSWD: '/x/pw' }, '/d')).toMatchObject({ etcDir: '/x/etc', stateDir: '/x/state', mosquittoPasswd: '/x/pw', capturesDir: '/d/captures' })
  })
})

describe('nodeBackupSources', () => {
  it('snapshots the live database to a single file and lists the state files', async () => {
    const store = new SqliteStore({ url: join(dir, 'live.db') })
    store.settings.update({ unitName: 'Kitchen' })
    mkdirSync(join(dir, 'state'))
    writeFileSync(join(dir, 'state/state.json'), '{}')
    writeFileSync(join(dir, 'state/sensors.json'), '[]')
    writeFileSync(join(dir, 'state/notes.txt'), 'ignored')
    const src = nodeBackupSources({ paths: { etcDir: join(dir, 'etc'), stateDir: join(dir, 'state'), mosquittoPasswd: join(dir, 'pw'), capturesDir: join(dir, 'captures') }, snapshot: d => store.backupTo(d), migrationsFolder: defaultMigrationsFolder() })
    const db = await src.database()
    expect(new TextDecoder().decode(db.subarray(0, 16))).toBe('SQLite format 3\0')
    expect(src.systemFiles().map(f => f.name)).toEqual(['etc/seedypod/hal.toml', 'etc/mosquitto/seedypod.passwd', 'var/lib/seedypod/sensors.json', 'var/lib/seedypod/state.json'])
    expect(new TextDecoder().decode(await src.read(join(dir, 'state/sensors.json')))).toBe('[]')
    expect(src.schema()).toEqual(readSchema(defaultMigrationsFolder()))
    store.close()
  })

  it('names the state file when the directory cannot be read, so the bundle says why', () => {
    mkdirSync(join(dir, 'state'))
    chmodSync(join(dir, 'state'), 0o000)
    const src = nodeBackupSources({ paths: { etcDir: dir, stateDir: join(dir, 'state'), mosquittoPasswd: join(dir, 'pw'), capturesDir: dir }, snapshot: async () => undefined, migrationsFolder: defaultMigrationsFolder() })
    const state = src.systemFiles().find(f => f.name === 'var/lib/seedypod/state.json')
    // Root reads anything; everyone else gets a non-optional entry whose read fails with EACCES.
    if (process.getuid?.() !== 0) expect(state).toMatchObject({ optional: false })
  })
})

describe('readSchema', () => {
  it('counts the migrations in the journal', () => {
    mkdirSync(join(dir, 'meta'))
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ entries: [{ tag: '0000_a' }, { tag: '0001_b' }] }))
    expect(readSchema(dir)).toEqual({ migrations: 2, tag: '0001_b' })
  })
})
