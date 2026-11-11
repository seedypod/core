import { expect, test } from '@playwright/test'

const WIDTHS = [390, 768, 1024, 1280, 1440]

test('water: the preset cards fit at every width, nothing clipped or overflowing', async ({ page }, info) => {
  // Five widths, each measured and photographed.
  test.setTimeout(120_000)
  await page.goto('/water')
  const main = page.getByRole('main')
  // A running preset (tinted) and another previewed (ringed), so both states are measured.
  await main.getByTestId('pump-preset-seedlings').click()
  await page.getByTestId('pump-strip').getByRole('button', { name: 'Apply' }).click()
  await expect(main.getByTestId('pump-running')).toHaveText('·Seedlings running')
  await main.getByTestId('pump-preset-germination').click()

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 })
    const grid = main.getByTestId('pump-presets')
    await grid.scrollIntoViewIfNeeded()
    // Every box inside the grid holds its contents, and the page itself doesn't scroll sideways.
    const over = await grid.evaluate(el => [el, ...el.querySelectorAll('*')]
      .filter(e => e instanceof HTMLElement && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)
      .map(e => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className.toString().slice(0, 40)} ${e.scrollWidth}>${e.clientWidth}`))
    expect(over, `overflow at ${width}px`).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `page scrolls sideways at ${width}px`).toBe(true)
    // Each card is at least 13.5rem wide, however many fit in a row.
    const narrowest = await grid.evaluate(el => Math.min(...[...el.children].map(c => c.getBoundingClientRect().width)))
    expect(narrowest).toBeGreaterThanOrEqual(width < 400 ? 200 : 215)
    // Kept beside the test's other artifacts for a look by eye.
    await grid.screenshot({ path: info.outputPath(`preset-cards-${width}.png`) })
  }

  // Back to no cycles, as the other specs expect.
  await page.setViewportSize({ width: 1280, height: 1000 })
  await main.getByRole('button', { name: 'Edit Seedlings · once a day 10 min (08:00)' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(main.getByTestId('pump-running')).toHaveCount(0)
})
