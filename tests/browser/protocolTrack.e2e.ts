import { expect, test } from '@playwright/test'

const WIDTHS = [390, 768, 1024, 1440]

// Back to an empty tower with no cycle, as the other specs expect.
test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/pods/1', { data: { plant: null, plantedAt: null, status: 'empty' } })).ok()).toBe(true)
  expect((await request.post('/api/grow/end', { headers: { 'content-type': 'application/json' } })).ok()).toBe(true)
})

test('grow: the protocol track and its panel fit at every width, the page never scrolling sideways', async ({ page }, info) => {
  // Four widths, each measured and photographed.
  test.setTimeout(120_000)
  // A basil pod sown today under an open cycle, so a stage is current and Hold and Then are live.
  const today = new Date().toISOString().slice(0, 10)
  expect((await page.request.patch('/api/pods/1', { data: { plant: 'Basil', plantedAt: today, status: 'seeded' } })).ok()).toBe(true)
  expect((await page.request.post('/api/grow/start', { data: { notes: 'e2e' } })).ok()).toBe(true)
  await page.goto('/grow')
  const card = page.getByRole('main').getByTestId('protocol')
  await expect(card.getByRole('group', { name: 'Stages' })).toBeVisible()
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 })
    await card.scrollIntoViewIfNeeded()
    // Nothing spills out of its box but the names cut short on purpose (`truncate`).
    const over = await card.evaluate(el => [el, ...el.querySelectorAll('*')]
      .filter(e => e instanceof HTMLElement && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1 && !e.classList.contains('truncate'))
      .map(e => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className.toString().slice(0, 40)} ${e.scrollWidth}>${e.clientWidth}`))
    expect(over, `overflow at ${width}px`).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `page scrolls sideways at ${width}px`).toBe(true)
    // The Then slot opens its panel at every width.
    await card.getByRole('button', { name: /^Then/ }).click()
    await expect(card.getByTestId('then-panel')).toBeVisible()
    await card.getByRole('button', { name: /^Germination/ }).click()
    // Kept beside the test's other artifacts for a look by eye.
    await card.screenshot({ path: info.outputPath(`protocol-track-${width}.png`) })
  }
})
