import { expect, test, type Page } from '@playwright/test'

const WIDTHS = [390, 768, 1024, 1280, 1440]

/**
 * pumpCycles' fmtDay, word for word: importing it here pulls in the plant
 * catalog's JSON, which Playwright's loader can't import.
 */
const fmtDay = (at: Date, timezone: string) => at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: timezone })

/** End any open grow cycle, as the Grow page's End does. */
async function endCycle(page: Page) {
  expect((await page.request.post('/api/grow/end', { headers: { 'content-type': 'application/json' } })).ok()).toBe(true)
}

/**
 * Delete every pump schedule through the API, until none is left. Not
 * through the page: right after a load its list can still be empty, and a
 * count taken then deletes nothing.
 */
async function clearPumpCycles(page: Page) {
  for (let i = 0; i < 5; i++) {
    const pumps = ((await (await page.request.get('/api/schedules')).json()) as Array<{ id: string, kind: string }>).filter(s => s.kind === 'pump')
    if (!pumps.length) return
    for (const s of pumps) expect((await page.request.delete(`/api/schedules/${encodeURIComponent(s.id)}`)).ok()).toBe(true)
  }
  throw new Error('pump schedules keep coming back')
}

// Back to no cycles and no grow cycle whatever happened, as the other specs expect.
test.afterEach(async ({ page }) => {
  await clearPumpCycles(page)
  await endCycle(page)
})

test('water: start germination today, then move the sowing day, fitting every width', async ({ page }, info) => {
  // Five widths, each measured and photographed.
  test.setTimeout(180_000)
  // From no grow cycle and no cycles, whatever earlier specs left.
  await endCycle(page)
  await clearPumpCycles(page)
  await page.goto('/water')
  const main = page.getByRole('main')
  const sown = main.getByTestId('sown')
  await sown.getByRole('button', { name: 'Start germination today' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Start' }).click()
  await expect(main.getByText(/^Germination · once a week 15 min \(08:00\)$/)).toBeVisible()
  await expect(sown.getByTestId('sown-on')).toHaveText(/^Sown \w{3} \d{1,2} \w{3}$/)

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 })
    await sown.scrollIntoViewIfNeeded()
    // Open the date editor too, the wider of its two states.
    await sown.getByText('Change').click()
    const over = await sown.evaluate(el => [el, ...el.querySelectorAll('*')]
      .filter(e => e instanceof HTMLElement && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)
      .map(e => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className.toString().slice(0, 40)} ${e.scrollWidth}>${e.clientWidth}`))
    expect(over, `overflow at ${width}px`).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `page scrolls sideways at ${width}px`).toBe(true)
    await sown.screenshot({ path: info.outputPath(`sown-${width}.png`) })
    await sown.getByRole('button', { name: 'Cancel' }).click()
  }

  // Sown the day before after all: the line moves, and so does germination's weekday.
  await sown.getByText('Change').click()
  const input = sown.getByLabel(/Sown on/)
  const yesterday = new Date(Date.parse(`${await input.inputValue()}T12:00:00Z`) - 86_400_000)
  await input.fill(yesterday.toISOString().slice(0, 10))
  await sown.getByRole('button', { name: 'Save' }).click()
  await expect(sown.getByTestId('sown-on')).toHaveText(`Sown ${fmtDay(yesterday, 'UTC')}`)
})
