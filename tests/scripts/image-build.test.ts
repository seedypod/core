/**
 * The choices in the OS image build that a typo could quietly undo. The build itself
 * needs Docker and emulation, so os-image.yml runs it when any of this changes.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(join(repo, path), 'utf8')

function imager() {
  const r = spawnSync('jq', ['-n', '--arg', 'url', 'https://x/seedypod-os.img.xz', '--arg', 'icon', 'https://x/icon.png', '--arg', 'date', '2026-11-06',
    '--arg', 'branch', 'dev', '--arg', 'commit', '83c4b1e', '--argjson', 'extract_size', '3000', '--arg', 'extract_sha256', 'aa',
    '--argjson', 'download_size', '600', '--arg', 'download_sha256', 'bb', '-f', join(repo, 'scripts/image/imager.jq')], { encoding: 'utf8' })
  expect(r.status).toBe(0)
  return JSON.parse(r.stdout) as { imager: { devices: { name: string, tags: string[] }[] }, os_list: Record<string, unknown>[] }
}

describe('the base image', () => {
  it('is 32-bit Lite on trixie, the only kind a Pi Zero W boots', () => {
    expect(read('scripts/image/base.env')).toMatch(/^BASE_URL=https:\/\/downloads\.raspberrypi\.com\/raspios_lite_armhf\/.*-raspios-trixie-armhf-lite\.img\.xz$/m)
  })

  it('is pinned by its sha256', () => {
    expect(read('scripts/image/base.env')).toMatch(/^BASE_SHA256=[0-9a-f]{64}$/m)
  })
})

describe('the Imager repository', () => {
  it('offers the image only on the boards it runs on, so a 64-bit OS can\'t be picked', () => {
    const { imager: { devices }, os_list: [os] } = imager()
    expect(devices.map(d => d.name)).toEqual(['Raspberry Pi Zero W', 'Raspberry Pi Zero 2 W'])
    expect(devices.flatMap(d => d.tags).every(t => t.endsWith('-32bit'))).toBe(true)
    expect(os?.devices).toEqual(['pi1-32bit', 'pi3-32bit'])
  })

  it('keeps Imager\'s customisation on, which is how a card gets its login and Wi-Fi', () => {
    expect(imager().os_list[0]?.init_format).toBe('cloudinit-rpi')
  })

  it('carries what Imager verifies the download with', () => {
    expect(imager().os_list[0]).toMatchObject({ url: 'https://x/seedypod-os.img.xz', extract_size: 3000, extract_sha256: 'aa', image_download_size: 600, image_download_sha256: 'bb' })
  })
})

describe('the CI job', () => {
  const workflow = read('.github/workflows/os-image.yml')

  it('stays off ordinary pull requests', () => {
    expect(workflow).toMatch(/pull_request:\n\s+paths:\n/)
  })

  it('is never cancelled by the next push, or no image would ever land', () => {
    expect(workflow).toContain('cancel-in-progress: false')
  })

  it('keeps the image through dev-release\'s asset refresh', () => {
    expect(read('.github/workflows/dev-release.yml')).toContain('grep -v \'^seedypod-os\'')
    expect(read('.github/workflows/dev-release.yml')).not.toContain('gh release delete dev-latest')
  })
})
