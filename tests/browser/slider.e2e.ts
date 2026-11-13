import { expect, test, type CDPSession, type Page } from '@playwright/test'

test.use({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 700 } })

/** Where the slider's track sits, where each stop is along it, and a finger to move along it. */
async function open(page: Page) {
  // By hand, from 50%.
  await page.request.post('/api/schedules/auto', { data: { on: false } })
  await page.request.post('/api/light', { data: { level: 50 } })
  await page.goto('/light')
  const slider = page.getByLabel('Brightness')
  await expect(slider).toHaveAttribute('aria-valuetext', '50%')
  const box = await slider.boundingBox()
  if (!box) throw new Error('the slider has no box')
  const cdp = await page.context().newCDPSession(page)
  // Auto, Off and the quarters, from the thumb's centre 9 px in at each end.
  const stop = (i: number) => box.x + 9 + (i * (box.width - 18)) / 5
  return { slider, box, stop, y: box.y + box.height / 2, cdp }
}

const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove', x: number, y: number) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x, y, id: 1 }] })
const lift = (cdp: CDPSession) => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

function commands(page: Page) {
  const sent: string[] = []
  page.on('request', r => r.url().includes('light.set') && sent.push(r.postData() ?? ''))
  return sent
}

test('touch: a tap on a stop moves the thumb and sends one command, even with a slow server', async ({ page }) => {
  await page.route('**/light.set**', async (r) => {
    await new Promise(resolve => setTimeout(resolve, 1000))
    await r.continue()
  })
  const { slider, stop, y } = await open(page)
  const sent = commands(page)
  await page.touchscreen.tap(stop(4), y)
  await expect(slider).toHaveAttribute('aria-valuetext', '75%', { timeout: 200 })
  await expect(page.getByTestId('light-level')).toHaveText('75%', { timeout: 200 })
  await expect.poll(() => page.request.get('/api/light').then(r => r.json()).then(j => j.level as number)).toBe(75)
  await expect(slider).toHaveAttribute('aria-valuetext', '75%')
  expect(sent).toHaveLength(1)
})

test('touch: the target is 44 px tall around the track', async ({ page }) => {
  const { slider, stop, y } = await open(page)
  await page.touchscreen.tap(stop(2), y + 20)
  await expect(slider).toHaveAttribute('aria-valuetext', '25%')
  await page.touchscreen.tap(stop(5), y - 20)
  await expect(slider).toHaveAttribute('aria-valuetext', '100%')
})

test('touch: a drag steps with the finger and sends one command at the end', async ({ page }) => {
  const { slider, stop, y, cdp } = await open(page)
  const sent = commands(page)
  await touch(cdp, 'touchStart', stop(2), y)
  await expect(slider).toHaveAttribute('aria-valuetext', '25%')
  for (let x = stop(2); x <= stop(4); x += 10) await touch(cdp, 'touchMove', x, y)
  await touch(cdp, 'touchMove', stop(4), y)
  await expect(slider).toHaveAttribute('aria-valuetext', '75%')
  expect(sent).toEqual([])
  await lift(cdp)
  await expect.poll(() => sent.length).toBe(1)
  await page.waitForTimeout(300)
  expect(sent).toHaveLength(1)
  await expect(slider).toHaveAttribute('aria-valuetext', '75%')
})

test('touch: a vertical swipe from the slider scrolls the page and leaves the level alone', async ({ page }) => {
  const { slider, stop, y, cdp } = await open(page)
  const sent = commands(page)
  await touch(cdp, 'touchStart', stop(5), y)
  for (let i = 1; i <= 12; i++) await touch(cdp, 'touchMove', stop(5), y - i * 12)
  await lift(cdp)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await expect(slider).toHaveAttribute('aria-valuetext', '50%')
  await page.waitForTimeout(300)
  expect(sent).toEqual([])
})
