/**
 * The SSH login logo on a real pseudo-terminal (tests/scripts/pty-run.py), since
 * nearly all of it turns on what's attached to stdin and stdout. How Raspberry
 * Pi OS's sshd and PAM reach it is on the hardware checklist.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generate } from '../../scripts/login-logo/generate.mjs'

vi.setConfig({ testTimeout: 20_000 })

const repo = resolve(import.meta.dirname, '../..')
const source = join(repo, 'scripts/login-logo')
const framesFile = join(source, 'logo.frames')
const LINE = 'seedypod dev@abc1234  http://seedypod.local:3000\r\n'
const SHOW_CURSOR = '\x1b[?25h'
const HIDE_CURSOR = '\x1b[?25l'

let dir: string
let share: string
let home: string
let logo: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'login-logo-'))
  share = join(dir, 'share')
  home = join(dir, 'home')
  logo = join(share, 'login-logo')
  mkdirSync(share)
  mkdirSync(home)
  copyFileSync(join(source, 'login-logo'), logo)
  // Three frames: only the tests that need the whole animation wait for it.
  writeFileSync(join(share, 'logo.frames'), records().slice(0, 6).join('\n'))
  writeFileSync(join(share, 'version'), 'dev@abc1234\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

interface Spec {
  argv?: string[]
  env?: Record<string, string | undefined>
  rows?: number
  cols?: number
  keys?: [number, string][]
  replies?: [string, string][]
  signals?: [number, number][]
}

function pty(spec: Spec = {}) {
  const env = { PATH: process.env.PATH, HOME: home, HOSTNAME: 'seedypod.lan', LANG: 'en_GB.UTF-8', TERM: 'xterm-kitty', ...spec.env }
  const r = spawnSync('python3', [join(repo, 'tests/scripts/pty-run.py'), JSON.stringify({ argv: ['bash', logo], ...spec, env })], { encoding: 'utf8' })
  const { output, status, first, last } = JSON.parse(r.stdout) as { output: string, status: number, first: number | null, last: number | null }
  return { out: Buffer.from(output, 'base64').toString('utf8'), status, seconds: (last ?? 0) - (first ?? 0) }
}

const count = (s: string, needle: string) => s.split(needle).length - 1
const records = () => readFileSync(framesFile, 'utf8').split('\n')
const allFrames = () => copyFileSync(framesFile, join(share, 'logo.frames'))
/** A wrapper that prints the terminal's settings after the logo. */
const framed = ['bash', '-c', 'bash "$0"; echo "exit=$?"; echo "tty: $(stty -a)"']
const COOKED = /tty: (?![^]*\s-(?:echo|icanon|isig)\s)/

describe('login-logo without a terminal', () => {
  it('prints nothing and takes no time', () => {
    const started = Date.now()
    const r = spawnSync('bash', [logo], { encoding: 'utf8', env: { ...process.env, HOME: home, TERM: 'xterm-kitty', LANG: 'en_GB.UTF-8' } })
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('prints nothing with only stdout on a terminal', () => {
    const r = pty({ argv: ['bash', '-c', 'bash "$0" </dev/null', logo] })
    expect(r.out).toBe('')
  })
})

describe('login-logo animation', () => {
  it('plays every frame in about a second and a half, ending below the logo', () => {
    allFrames()
    const r = pty({ env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
    const lines = records()
    expect(r.status).toBe(0)
    expect(r.out.startsWith(HIDE_CURSOR)).toBe(true)
    for (const frame of lines.slice(3).filter(Boolean)) expect(r.out).toContain(frame)
    expect(r.out).toContain(lines[1])
    expect(r.seconds).toBeGreaterThan(1.2)
    expect(r.seconds).toBeLessThan(4)
    expect(r.out.endsWith(`\x1b[20B\r\r\n\x1b[0m${SHOW_CURSOR}`)).toBe(true)
  })

  it('writes the version and the address beside the logo', () => {
    const r = pty()
    expect(r.out).toContain('\x1b[46C\x1b[38;5;245mdev@abc1234')
    expect(r.out).toContain('\x1b[46C\x1b[38;5;72mhttp://seedypod.local:3000\x1b[0m')
  })

  it('drops the port when port 80 forwards to core', () => {
    writeFileSync(join(share, 'port80.nft'), '')
    const r = pty()
    expect(r.out).toContain('\x1b[46C\x1b[38;5;72mhttp://seedypod.local\x1b[0m')
    expect(r.out).not.toContain(':3000')
  })

  it('leaves the version out when none was installed', () => {
    rmSync(join(share, 'version'))
    const r = pty()
    expect(r.out).toContain('http://seedypod.local:3000')
    expect(r.out).not.toContain('\x1b[38;5;245m')
  })

  it('recognises truecolor from TERM and from iTerm2\'s forwarded LC_TERMINAL', () => {
    expect(count(pty({ env: { TERM: 'xterm-ghostty' } }).out, records()[4])).toBe(1)
    expect(count(pty({ env: { TERM: 'xterm-256color', LC_TERMINAL: 'iTerm2' } }).out, records()[4])).toBe(1)
  })
})

describe('login-logo still fallback', () => {
  it('draws the 256-colour logo on a 256color terminal, without asking it anything', () => {
    // macOS Terminal printed an unanswered DECRQSS's "$qm" above the logo.
    const r = pty({ env: { TERM: 'xterm-256color' }, replies: [['\x1b[c', '\x1bP1$r0;38:2:1:2:3m\x1b\\\x1b[?62;22c']] })
    expect(r.out).toContain(records()[2])
    expect(r.out).not.toContain(records()[4])
    expect(r.out).not.toContain('\x1bP')
    expect(r.out).not.toContain('\x1b[c')
    expect(r.out).not.toContain('$qm')
    expect(r.out.endsWith(SHOW_CURSOR)).toBe(true)
  })

  it.each<[string, Spec]>([
    ['too narrow', { cols: 72 }],
    ['too short', { rows: 21 }],
    ['of unknown size', { rows: 0, cols: 0 }],
    ['TERM=dumb', { env: { TERM: 'dumb', COLORTERM: 'truecolor' } }],
    ['TERM unset', { env: { TERM: undefined } }],
    ['NO_COLOR', { env: { NO_COLOR: '1' } }],
    ['the Linux console', { env: { TERM: 'linux' } }],
    ['a non-UTF-8 locale', { env: { LANG: 'C' } }],
  ])('prints one plain line when %s', (_name, spec) => {
    const r = pty(spec)
    expect(r).toMatchObject({ out: LINE, status: 0 })
  })

  it('leaves out the blank lines on a terminal with no room for them', () => {
    expect(pty({ rows: 22 }).out).toContain(`\x1b[20B\r\x1b[0m${SHOW_CURSOR}`)
  })

  it('fits the longest it can at 80 columns and falls back past that', () => {
    expect(pty({ env: { HOSTNAME: 'x'.repeat(13) } }).out).toContain(`http://${'x'.repeat(13)}.local:3000`)
    expect(pty({ env: { HOSTNAME: 'x'.repeat(40) } }).out).not.toContain('\x1b')
  })

  it('prints the line alone if the frames are missing', () => {
    rmSync(join(share, 'logo.frames'))
    expect(pty().out).toBe(LINE)
  })
})

describe('login-logo opt-outs', () => {
  it('stays out of the way of ~/.hushlogin and SEEDYPOD_NO_LOGO=1', () => {
    expect(pty({ env: { SEEDYPOD_NO_LOGO: '1' } }).out).toBe('')
    writeFileSync(join(home, '.hushlogin'), '')
    expect(pty().out).toBe('')
  })

  it('stays quiet under sudo -i, which isn\'t a new login', () => {
    expect(pty({ env: { SUDO_USER: 'pi' } }).out).toBe('')
  })
})

describe('login-logo interruptions', () => {
  it.each([['any key', 'x'], ['Enter', '\r'], ['Ctrl-C', '\x03']])('%s jumps to the final frame and restores the terminal', (_name, key) => {
    allFrames()
    const r = pty({ argv: [...framed, logo], keys: [[0.5, key]] })
    const lines = records()
    expect(r.out).toContain(lines[1])
    expect(r.out).not.toContain(lines.at(-5))
    expect(r.out).toContain(`${SHOW_CURSOR}exit=0`)
    expect(r.out).toMatch(COOKED)
  })

  it('takes SIGINT as a keypress', () => {
    allFrames()
    const r = pty({ argv: ['bash', '-c', 'trap : INT; bash "$0"; echo "exit=$?"', logo], signals: [[0.5, 2]] })
    expect(r.out).toContain(records()[1])
    expect(r.out).not.toContain(records().at(-5))
    expect(r.out).toContain(`${SHOW_CURSOR}exit=0`)
  })

  it('restores the terminal on SIGTERM, below the logo', () => {
    allFrames()
    const r = pty({ argv: ['bash', '-c', `trap : TERM; ${framed[2]}`, logo], signals: [[0.5, 15]] })
    expect(r.out).not.toContain(records()[1])
    expect(r.out).toContain(`\x1b[20B\r\r\n\x1b[0m${SHOW_CURSOR}`)
    expect(r.out).toMatch(COOKED)
  })
})

describe('logo.frames', () => {
  /** Plays terminal bytes into a grid, tracking what each cell ended up showing. */
  function play(screen: Map<string, string>, data: string, at = { row: 0, col: 0 }) {
    let pen = ''
    // eslint-disable-next-line no-control-regex
    for (const [, csi, final, ch] of data.matchAll(/\x1b\[([\d;]*)([A-Za-z])|(\r|[^\x1b])/gu) as Iterable<string[]>) {
      if (ch === '\r') at.col = 0
      else if (ch) screen.set(`${at.row},${at.col++}`, `${pen}${ch}`)
      else if (final === 'm') pen = csi === '0' ? '' : `${pen};${csi}`.replace(/^.*;(?=(38|48))/, ';')
      else if (final === 'A') at.row -= Number(csi)
      else if (final === 'B') at.row += Number(csi)
      else if (final === 'C') at.col += Number(csi)
      else if (final === 'D') at.col -= Number(csi)
    }
    return at
  }
  const glyphs = (screen: Map<string, string>) =>
    new Map([...screen].map(([cell, drawn]) => [cell, drawn.slice(-1)]).filter(([, ch]) => ch !== ' ') as [string, string][])

  it('fits its budget and an 80x24 terminal', () => {
    expect(statSync(framesFile).size).toBeLessThan(150 * 1024)
    const [rows, textCol, , delay] = records()[0].split(' ').map(Number)
    expect(rows).toBeGreaterThanOrEqual(18)
    expect(rows).toBeLessThanOrEqual(22)
    expect(textCol + 'http://seedypod.local:3000'.length).toBeLessThan(80)
    expect(delay * (records().length - 4)).toBeGreaterThan(1.2)
    expect(delay * (records().length - 4)).toBeLessThan(1.8)
  })

  it('draws the same logo in both colour depths, in half blocks', () => {
    const [true24, true256] = [records()[1], records()[2]].map((line) => {
      const screen = new Map<string, string>()
      expect(play(screen, line)).toEqual({ row: 0, col: 0 })
      return glyphs(screen)
    })
    expect(true256).toEqual(true24)
    const logoCells = [...true24.values()].filter(ch => !/[a-z]/.test(ch))
    expect(logoCells.length).toBeGreaterThan(400)
    expect(new Set(logoCells)).toEqual(new Set(['▀', '▄', '█']))
    expect([...true24.values()].filter(ch => /[a-z]/.test(ch)).join('')).toBe('seedypod')
    // The word, and the facts under it, start level with the top of the logo.
    const [, textCol, textRow] = records()[0].split(' ').map(Number)
    expect(textRow).toBe(0)
    expect(true24.get(`0,${textCol}`)).toBe('s')
    expect([...true24].some(([cell, ch]) => cell.startsWith('0,') && !/[a-z]/.test(ch))).toBe(true)
  })

  it('lands the animation exactly on the final frame, from the corner it started in', () => {
    const played = new Map<string, string>()
    for (const frame of records().slice(3, -1)) expect(play(played, frame)).toEqual({ row: 0, col: 0 })
    const final = new Map<string, string>()
    play(final, records()[1])
    expect(glyphs(played)).toEqual(glyphs(final))
  })

  const lfsPointer = readFileSync(join(repo, 'web/public/brand/icon-192.png')).toString('latin1', 0, 8) === 'version '
  it.skipIf(lfsPointer)('is what the generator makes of the icon', () => {
    expect(generate()).toBe(readFileSync(framesFile, 'utf8'))
  })
})

describe('profile.d hook', () => {
  let hook: string

  beforeEach(() => {
    hook = join(dir, 'seedypod-logo.sh')
    writeFileSync(hook, readFileSync(join(source, 'profile.sh'), 'utf8').replaceAll('/usr/local/share/seedypod', share))
    // The hook's job is deciding whether to start the logo, so count the starts.
    writeFileSync(logo, `#!/bin/sh\necho started >> "${join(dir, 'starts')}"\n`)
    chmodSync(logo, 0o755)
  })
  const starts = () => existsSync(join(dir, 'starts')) ? count(readFileSync(join(dir, 'starts'), 'utf8'), 'started') : 0
  const shell = (rc: string, spec: Spec = {}) => {
    writeFileSync(join(dir, 'rc'), `. "${hook}"\n${rc}\nexit\n`)
    return pty({ argv: ['bash', '--noprofile', '--rcfile', join(dir, 'rc'), '-i'], ...spec, env: { PS1: '', ...spec.env } })
  }

  it.each([['bash'], ['sh']])('does nothing when a non-interactive %s sources it', (sh) => {
    const r = spawnSync(sh, ['-c', `. "${hook}"; echo "shown=\${SEEDYPOD_LOGO_SHOWN:-no}"`], { encoding: 'utf8' })
    expect(r).toMatchObject({ status: 0, stdout: 'shown=no\n', stderr: '' })
    expect(starts()).toBe(0)
  })

  it('does nothing for a login shell running a command, even on a terminal', () => {
    pty({ argv: ['bash', '-c', `. "${hook}"; true`] })
    expect(starts()).toBe(0)
  })

  it('does nothing for an interactive shell with no terminal', () => {
    const r = spawnSync('bash', ['--noprofile', '--rcfile', hook, '-i'], { input: 'exit\n', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, PS1: '' } })
    expect(r.status).toBe(0)
    expect(starts()).toBe(0)
  })

  it('starts the logo once per login, not again in a subshell', () => {
    writeFileSync(join(dir, 'nested'), `. "${hook}"\nexit\n`)
    shell(`bash --noprofile --rcfile "${join(dir, 'nested')}" -i`)
    expect(starts()).toBe(1)
  })

  it.each([['TMUX', '/tmp/tmux-1000/default,1,0'], ['STY', '1234.pts-0.seedypod']])('leaves %s panes alone', (name, value) => {
    shell('', { env: { [name]: value } })
    expect(starts()).toBe(0)
  })

  it('starts the logo from sh too', () => {
    writeFileSync(join(dir, 'env'), `. "${hook}"\nexit\n`)
    pty({ argv: ['sh', '-i'], env: { ENV: join(dir, 'env'), PS1: '' } })
    expect(starts()).toBe(1)
  })

  it('survives the logo being gone', () => {
    rmSync(logo)
    expect(shell('echo after-logo').out).toContain('after-logo')
  })

  it('keeps going through the startup files when Ctrl-C lands outside the logo', () => {
    writeFileSync(logo, '#!/bin/sh\nsleep 1\n')
    expect(shell('echo after-logo', { keys: [[0.4, '\x03']] }).out).toContain('after-logo')
  })
})

describe('scripts/install --login-logo', () => {
  let bin: string
  let root: string
  let prefix: string

  const install = (env = {}) => spawnSync('bash', [join(repo, 'scripts/install'), '--login-logo', '--prefix', prefix], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SEEDYPOD_ROOT: root, ...env },
  })

  beforeEach(() => {
    bin = join(dir, 'bin')
    root = join(dir, 'root')
    prefix = join(dir, 'opt')
    for (const d of [bin, root, join(prefix, 'scripts/login-logo')]) mkdirSync(d, { recursive: true })
    for (const f of ['login-logo', 'login-stats', 'logo.frames', 'profile.sh']) copyFileSync(join(source, f), join(prefix, 'scripts/login-logo', f))
    writeFileSync(join(prefix, '.git-info'), JSON.stringify({ branch: 'main', commitHash: 'abc1234' }, null, 2))
    writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n')
    writeFileSync(join(bin, 'chown'), `#!/bin/sh\necho "chown $*" >> "${join(dir, 'chowns')}"\n`)
    chmodSync(join(bin, 'sudo'), 0o755)
    chmodSync(join(bin, 'chown'), 0o755)
  })

  const installed = () => join(root, 'usr/local/share/seedypod')
  const hook = () => join(root, 'etc/profile.d/seedypod-logo.sh')

  it('puts the logo outside the prefix, owned by root, with the version pinned', () => {
    expect(install()).toMatchObject({ status: 0, stderr: '' })
    expect(readFileSync(join(installed(), 'logo.frames'))).toEqual(readFileSync(framesFile))
    expect(readFileSync(hook(), 'utf8')).toBe(readFileSync(join(source, 'profile.sh'), 'utf8'))
    expect(readFileSync(join(installed(), 'version'), 'utf8')).toBe('main@abc1234\n')
    expect(statSync(join(installed(), 'login-logo')).mode & 0o777).toBe(0o755)
    expect(readFileSync(join(installed(), 'login-stats'))).toEqual(readFileSync(join(source, 'login-stats')))
    expect(statSync(join(installed(), 'login-stats')).mode & 0o777).toBe(0o755)
    expect(statSync(hook()).mode & 0o777).toBe(0o644)
    expect(readFileSync(join(dir, 'chowns'), 'utf8')).toContain(`chown root:root ${installed()} ${join(installed(), 'login-logo')} ${join(installed(), 'login-stats')}`)
  })

  it('replaces what a previous install left', () => {
    expect(install().status).toBe(0)
    writeFileSync(join(prefix, '.git-info'), JSON.stringify({ branch: 'main', commitHash: 'def5678' }))
    writeFileSync(join(prefix, 'scripts/login-logo/profile.sh'), '# newer\n')
    expect(install().status).toBe(0)
    expect(readFileSync(join(installed(), 'version'), 'utf8')).toBe('main@def5678\n')
    expect(readFileSync(hook(), 'utf8')).toBe('# newer\n')
  })

  it('calls a tree without .git-info dev, as core does', () => {
    rmSync(join(prefix, '.git-info'))
    expect(install().status).toBe(0)
    expect(readFileSync(join(installed(), 'version'), 'utf8')).toBe('dev\n')
  })

  it('reports failure when the files aren\'t there', () => {
    rmSync(join(prefix, 'scripts/login-logo'), { recursive: true })
    expect(install().status).not.toBe(0)
  })
})
