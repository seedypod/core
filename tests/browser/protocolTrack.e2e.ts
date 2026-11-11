import { expect, test } from '@playwright/test'

const WIDTHS = [390, 768, 1024, 1440]

// Back to an empty tower with no cycle, as the other specs expect.
test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/pods/1', { data: { plant: null, plantedAt: null, status: 'empty' } })).ok()).toBe(true)
  expect((await request.post('/api/grow/end', { headers: { 'content-type': 'application/json' } })).ok()).toBe(true)
  for (const e of (await (await request.get('/api/schedules/library')).json()) as Array<{ id: string, kind: string }>) {
    if (e.kind === 'own') expect((await request.delete(`/api/schedules/library/${e.id}`)).ok()).toBe(true)
  }
})

test('grow: the protocol track and its panel fit at every width, the page never scrolling sideways', async ({ page }, info) => {
  // Four widths, each measured and photographed.
  test.setTimeout(120_000)
  // A basil pod sown today under an open cycle, so a stage is current and Hold and Then are live.
  const today = new Date().toISOString().slice(0, 10)
  expect((await page.request.patch('/api/pods/1', { data: { plant: 'Basil', plantedAt: today, status: 'seeded' } })).ok()).toBe(true)
  expect((await page.request.post('/api/grow/start', { data: { notes: 'e2e' } })).ok()).toBe(true)
  // A schedule of your own, so the Then panel has its picker and Switch now to measure.
  expect((await page.request.post('/api/schedules/library', { data: { name: 'Summer evenings', cycles: [{ minute: 420, durationS: 300, days: 127 }, { minute: 1020, durationS: 300, days: 127 }] } })).ok()).toBe(true)
  await page.goto('/grow')
  const card = page.getByRole('main').getByTestId('protocol')
  await expect(card.getByRole('group', { name: 'Stages' })).toBeVisible()
  // Nothing spills out of its box but the names cut short on purpose (`truncate`).
  const overflow = () => card.evaluate(el => [el, ...el.querySelectorAll('*')]
    .filter(e => e instanceof HTMLElement && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1 && !e.classList.contains('truncate'))
    .map(e => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className.toString().slice(0, 40)} ${e.scrollWidth}>${e.clientWidth}`))
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 })
    // The current stage's panel, then the Then slot's: each measured and photographed.
    await card.getByRole('button', { name: /^Germination/ }).click()
    await card.scrollIntoViewIfNeeded()
    expect(await overflow(), `overflow at ${width}px`).toEqual([])
    // Polled: a resize settles over a frame or two (charts and the tower measure themselves after it).
    await expect.poll(sideways, { message: `page scrolls sideways at ${width}px` }).toBe(false)
    // Kept beside the test's other artifacts for a look by eye.
    await card.screenshot({ path: info.outputPath(`protocol-track-${width}.png`) })
    await card.getByRole('button', { name: /^Then/ }).click()
    await expect(card.getByTestId('then-panel')).toBeVisible()
    expect(await overflow(), `overflow with Then open at ${width}px`).toEqual([])
    await expect.poll(sideways, { message: `page scrolls sideways with Then open at ${width}px` }).toBe(false)
    await card.screenshot({ path: info.outputPath(`protocol-then-${width}.png`) })
  }
})
