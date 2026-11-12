import { expect, test, type CDPSession, type Page } from '@playwright/test'

test.use({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 700 } })

/** Where the slider's track sits, and a finger to move along it. */
async function open(page: Page) {
  await page.request.post('/api/light', { data: { level: 40 } })
  await page.goto('/light')
  const slider = page.getByLabel('Brightness')
  await expect(slider).toHaveValue('40')
  const box = await slider.boundingBox()
  if (!box) throw new Error('the slider has no box')
  const cdp = await page.context().newCDPSession(page)
  return { slider, box, y: box.y + box.height / 2, cdp }
}

const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove', x: number, y: number) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x, y, id: 1 }] })
const lift = (cdp: CDPSession) => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

function commands(page: Page) {
  const sent: string[] = []
  page.on('request', r => r.url().includes('light.set') && sent.push(r.postData() ?? ''))
  return sent
}

test('touch: a tap anywhere on the track moves the thumb and sends one command, even with a slow server', async ({ page }) => {
  await page.route('**/light.set**', async (r) => {
    await new Promise(resolve => setTimeout(resolve, 1000))
    await r.continue()
  })
  const { slider, box, y } = await open(page)
  const sent = commands(page)
  await page.touchscreen.tap(box.x + box.width * 0.75, y)
  await expect(slider).toHaveValue('75', { timeout: 200 })
  await expect(page.getByTestId('light-level')).toHaveText('75%', { timeout: 200 })
  await expect.poll(() => page.request.get('/api/light').then(r => r.json()).then(j => j.level as number)).toBe(75)
  await expect(slider).toHaveValue('75')
  expect(sent).toHaveLength(1)
})

test('touch: the target is 44 px tall around the track', async ({ page }) => {
  const { slider, box, y } = await open(page)
  await page.touchscreen.tap(box.x + box.width * 0.25, y + 20)
  await expect(slider).toHaveValue('25')
  await page.touchscreen.tap(box.x + box.width * 0.5, y - 20)
  await expect(slider).toHaveValue('50')
})

test('touch: a drag follows the finger and sends one command at the end', async ({ page }) => {
  const { slider, box, y, cdp } = await open(page)
  const sent = commands(page)
  await touch(cdp, 'touchStart', box.x + box.width * 0.2, y)
  await expect(slider).toHaveValue('20')
  for (let pct = 0.25; pct <= 0.6; pct += 0.05) await touch(cdp, 'touchMove', box.x + box.width * pct, y)
  await expect(slider).toHaveValue('60')
  expect(sent).toEqual([])
  await lift(cdp)
  await expect.poll(() => sent.length).toBe(1)
  await page.waitForTimeout(300)
  expect(sent).toHaveLength(1)
  await expect(slider).toHaveValue('60')
})

test('touch: a vertical swipe from the slider scrolls the page and leaves the level alone', async ({ page }) => {
  const { slider, box, y, cdp } = await open(page)
  const sent = commands(page)
  await touch(cdp, 'touchStart', box.x + box.width * 0.9, y)
  for (let i = 1; i <= 12; i++) await touch(cdp, 'touchMove', box.x + box.width * 0.9, y - i * 12)
  await lift(cdp)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await expect(slider).toHaveValue('40')
  await page.waitForTimeout(300)
  expect(sent).toEqual([])
})
