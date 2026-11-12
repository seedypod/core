import { expect, type Page, test } from '@playwright/test'
import { encode } from 'jpeg-js'

// The sim's cameras send no real image, so the spec stands in for the upper
// camera's list and its stills. Routing also turns off the browser's HTTP
// cache, so every request counted here really went to the unit.
const JPEG = encode({ width: 8, height: 6, data: Buffer.alloc(8 * 6 * 4, 120) }, 80).data
const ids = Array.from({ length: 6 }, (_, i) => `upper-2026-11-0${i + 1}T10-00-00-000Z`)
const frames = ids.map((id, i) => ({ id, camera: 'upper', ts: `2026-11-0${i + 1}T10:00:00.000Z`, path: `${id}.jpg`, bytes: JPEG.length, url: `/api/captures/${id}.jpg` })).reverse()

async function standIn(page: Page): Promise<{ hits: number }> {
  const count = { hits: 0 }
  await page.route(/\/api\/trpc\/[^?]*camera\.list/, async (route) => {
    const url = new URL(route.request().url())
    const procs = url.pathname.split('/').at(-1)?.split(',') ?? []
    const input = JSON.parse(url.searchParams.get('input') ?? '{}') as Record<string, { json?: { camera?: string } }>
    const res = await route.fetch()
    const body = await res.json() as Array<{ result: { data: { json: unknown } } }>
    procs.forEach((p, i) => {
      const r = body[i]
      if (r && p === 'camera.list' && input[i]?.json?.camera === 'upper') r.result.data.json = frames
    })
    await route.fulfill({ response: res, json: body })
  })
  await page.route('**/api/captures/*.jpg', (route) => {
    count.hits++
    return route.fulfill({ contentType: 'image/jpeg', body: JPEG })
  })
  return count
}

async function playThrough(page: Page) {
  const card = page.getByTestId('camera-upper')
  await card.getByRole('button', { name: 'Play upper timelapse' }).click()
  await expect(card.getByRole('button', { name: 'Pause upper timelapse' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Play upper timelapse' })).toBeVisible({ timeout: 10_000 })
  await expect(card.getByText('6 / 6')).toBeVisible()
  await expect(card.getByRole('img', { name: `upper camera at ${frames[0]?.ts}` })).toHaveAttribute('src', /^blob:/)
}

test('cameras: timelapse plays at phone width, and replays come from the browser cache', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const count = await standIn(page)
  await page.goto('/cameras')
  const card = page.getByTestId('camera-upper')
  await expect(card.getByText('6 / 6')).toBeVisible()
  await card.getByRole('button', { name: 'Upper playback speed' }).click()
  await expect(card.getByText('10 fps')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // The latest still as the page opens, then the six the player fetched.
  await playThrough(page)
  expect(count.hits).toBe(7)

  await playThrough(page)
  expect(count.hits).toBe(7)

  // A revisit fetches only the latest still the page opens on.
  await page.reload()
  await playThrough(page)
  expect(count.hits).toBe(8)
})
