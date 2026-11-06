/**
 * install-hal's warning for a login that shares a name with hald's service user,
 * with getent stubbed for the accounts on the card.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install-hal')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-hal-login-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function warn(passwd: string) {
  writeFileSync(join(dir, 'getent'), `#!/bin/sh\n[ -n '${passwd}' ] || exit 2\necho '${passwd}'\n`)
  chmodSync(join(dir, 'getent'), 0o755)
  const r = spawnSync('bash', ['-c', `source "${script}"; warn_shared_login seedypod`], {
    encoding: 'utf8',
    env: { PATH: `${dir}:/usr/bin:/bin`, SEEDYPOD_LIB_ONLY: '1' },
  })
  return { code: r.status, err: r.stderr }
}

describe('a login named seedypod', () => {
  it('warns that hald will run as the login, and doesn\'t stop the install', () => {
    const r = warn('seedypod:x:1000:1000:,,,:/home/seedypod:/bin/bash')
    expect(r.code).toBe(0)
    expect(r.err).toContain('The login seedypod is also hald\'s service user')
    expect(r.err).toContain('reflash with another username')
  })

  it('stays quiet on a rerun, when the account is the locked one install-hal made', () => {
    expect(warn('seedypod:x:997:997::/var/lib/seedypod:/usr/sbin/nologin')).toEqual({ code: 0, err: '' })
  })

  it('stays quiet on a first run, with no such account yet', () => {
    expect(warn('')).toEqual({ code: 0, err: '' })
  })
})
