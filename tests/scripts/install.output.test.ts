/**
 * What the installers print: colour on a terminal only, and the login screen's
 * logo as a banner. A real pseudo-terminal (tests/scripts/pty-run.py) stands in
 * for curl | bash, whose stdout is still the terminal.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BANNER_END, BANNER_START, banner } from '../../scripts/login-logo/generate.mjs'

vi.setConfig({ testTimeout: 20_000 })

const repo = resolve(import.meta.dirname, '../..')
const SCRIPTS = ['install', 'install-hal'].map(name => join(repo, 'scripts', name))
const ESC = '\x1b['
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g
const LINES = 'step "installing Node"; ok "runs core"; note "  detail"; warn "   no nftables"; fail "no build"; error "unknown arg"; success "running"'
const PLAIN_OUT = '→ installing Node\n✓ runs core\n  detail\n✓ running\n'
const PLAIN_ERR = '   no nftables\n✗ no build\nunknown arg\n'
const TERMINAL = { PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'en_GB.UTF-8' }

/** Sources `script` for its helpers alone, then runs `body`, with nothing attached to a terminal. */
function piped(script: string, body: string, env: Record<string, string | undefined> = {}) {
  const r = spawnSync('bash', ['-c', `source "$0"; ${body}`, script], {
    encoding: 'utf8',
    env: { ...TERMINAL, SEEDYPOD_LIB_ONLY: '1', ...env },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** The same on a terminal `cols` wide; stdout and stderr arrive together, with \r\n. */
function tty(script: string, body: string, env: Record<string, string | undefined> = {}, cols = 80, before = '') {
  const spec = { argv: ['bash', '-c', `${before}source "$0"; ${body}`, script], env: { ...TERMINAL, SEEDYPOD_LIB_ONLY: '1', ...env }, cols, rows: 40 }
  const r = spawnSync('python3', [join(repo, 'tests/scripts/pty-run.py'), JSON.stringify(spec)], { encoding: 'utf8' })
  const { output, status } = JSON.parse(r.stdout) as { output: string, status: number }
  return { code: status, out: Buffer.from(output, 'base64').toString('utf8').replaceAll('\r\n', '\n') }
}

const logoBlock = (script: string) => {
  const text = readFileSync(script, 'utf8')
  return text.slice(text.indexOf(BANNER_START), text.indexOf(BANNER_END) + BANNER_END.length)
}

describe.each(SCRIPTS)('%s output', (script) => {
  it('is plain text when piped, as to a log, tee or the image bake', () => {
    expect(piped(script, LINES)).toEqual({ code: 0, out: PLAIN_OUT, err: PLAIN_ERR })
  })

  it('is plain text with SEEDYPOD_COLOR=never, even on a terminal', () => {
    const r = tty(script, LINES, { SEEDYPOD_COLOR: 'never' })
    expect(r.out).not.toContain(ESC)
    expect(r.out).toContain('→ installing Node\n')
  })

  it('is plain text on a terminal with NO_COLOR set', () => {
    expect(tty(script, LINES, { NO_COLOR: '1' }).out).not.toContain(ESC)
  })

  it('is plain text on a dumb terminal', () => {
    expect(tty(script, LINES, { TERM: 'dumb' }).out).not.toContain(ESC)
  })

  it('is coloured on a terminal, as under curl | bash', () => {
    const { out } = tty(script, LINES)
    expect(out).toContain(`${ESC}36m→${ESC}0m installing Node\n`)
    expect(out).toContain(`${ESC}32m✓${ESC}0m runs core\n`)
    expect(out).toContain(`${ESC}2m  detail${ESC}0m\n`)
    expect(out).toContain(`${ESC}33m   no nftables${ESC}0m\n`)
    expect(out).toContain(`${ESC}31m✗ no build${ESC}0m\n`)
    expect(out).toContain(`${ESC}32m✓${ESC}0m ${ESC}1mrunning${ESC}0m\n`)
  })

  it('is coloured with SEEDYPOD_COLOR=always, even piped, and keeps errors on stderr', () => {
    const r = piped(script, LINES, { SEEDYPOD_COLOR: 'always' })
    expect(r.out).toContain(`${ESC}36m→${ESC}0m installing Node`)
    expect(r.out).not.toContain('no build')
    expect(r.err).toContain(`${ESC}31m✗ no build${ESC}0m`)
    expect(r.out.replaceAll(SGR, '')).toBe(PLAIN_OUT)
    expect(r.err.replaceAll(SGR, '')).toBe(PLAIN_ERR)
  })

  it('colours stderr alone when only stderr is a terminal', () => {
    const { out } = tty(script, LINES, {}, 80, 'exec >/dev/null; ')
    expect(out).toContain(`${ESC}33m   no nftables`)
    expect(out).not.toContain('installing Node')
  })
})

describe.each(SCRIPTS)('%s banner', (script) => {
  const BANNER = 'banner "core installer · branch dev"'

  it('prints nothing when not on a terminal', () => {
    expect(piped(script, BANNER)).toEqual({ code: 0, out: '', err: '' })
  })

  it('shows the logo with the subtitle beside the word on a terminal', () => {
    const { out } = tty(script, BANNER)
    const lines = out.split('\n')
    expect(lines).toHaveLength(1 + 20 + 1 + 1)
    expect(out).toContain('▀')
    expect(out).toContain(`${ESC}38;5;`)
    expect(lines[1 + 9]).toContain(`\r${ESC}46C${ESC}2mcore installer · branch dev${ESC}0m`)
    expect(out.replaceAll(SGR, '')).toContain('seedypod')
    // Every row ends with the colour reset, so nothing bleeds into what follows.
    for (const line of lines.slice(1, 21)) expect(line === '' || line.endsWith(`${ESC}0m`) || !line.includes(ESC)).toBe(true)
  })

  it('puts the subtitle under the logo when it won\'t fit beside it', () => {
    const { out } = tty(script, BANNER, {}, 60)
    expect(out).not.toContain(`${ESC}46C`)
    expect(out).toContain(`\n  ${ESC}2mcore installer · branch dev${ESC}0m\n\n`)
  })

  it('falls back to one line in a window narrower than the logo', () => {
    const { out } = tty(script, BANNER, {}, 50)
    expect(out).toBe(`${ESC}1mseedypod core installer · branch dev${ESC}0m\n\n`)
  })

  it('falls back to one plain line without colour or UTF-8', () => {
    expect(tty(script, BANNER, { NO_COLOR: '1' }).out).toBe('seedypod core installer · branch dev\n\n')
    expect(tty(script, BANNER, { LANG: 'C' }).out).toBe(`${ESC}1mseedypod core installer · branch dev${ESC}0m\n\n`)
  })
})

describe('the installers\' logo', () => {
  it('is the same block in both installers', () => {
    expect(logoBlock(SCRIPTS[0])).toBe(logoBlock(SCRIPTS[1]))
    expect(logoBlock(SCRIPTS[0])).toContain('UI_LOGO=(')
  })

  it('is no wider than an 80-column terminal leaves room for', () => {
    const cols = Number(/^UI_LOGO_COLS=(\d+)$/m.exec(logoBlock(SCRIPTS[0]))?.[1])
    expect(cols).toBeGreaterThan(0)
    expect(cols).toBeLessThanOrEqual(60)
  })

  const lfsPointer = readFileSync(join(repo, 'web/public/brand/icon-192.png')).toString('latin1', 0, 8) === 'version '
  it.skipIf(lfsPointer)('is what the generator makes of the icon', () => {
    for (const script of SCRIPTS) expect(logoBlock(script)).toBe(banner())
  })
})

describe('scripts/install', () => {
  it('opens a run with the banner, before anything else', () => {
    const text = readFileSync(SCRIPTS[0], 'utf8')
    expect(text.indexOf('banner "core installer · branch $BRANCH"')).toBeLessThan(text.indexOf('node_plan || exit 3'))
  })
})
