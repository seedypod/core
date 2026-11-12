import { expect, test, type Page } from '@playwright/test'

const WIDTHS = [390, 768, 1024, 1440]
/** Lights on 06:00–21:00, the band the schedules are drawn on and checked against. */
const LIGHT = { id: 'e2e-light', kind: 'light', name: 'e2e day', enabled: true, days: 127, spec: { setpoints: [{ minute: 0, level: 0 }, { minute: 359, level: 0 }, { minute: 360, level: 100 }, { minute: 1259, level: 100 }, { minute: 1260, level: 0 }] } }

// Back to an empty tower with no cycle, no schedules of your own and no pump cycles, as the other specs expect.
test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/pods/1', { data: { plant: null, plantedAt: null, status: 'empty' } })).ok()).toBe(true)
  expect((await request.post('/api/grow/end', { headers: { 'content-type': 'application/json' } })).ok()).toBe(true)
  for (const e of (await (await request.get('/api/schedules/library')).json()) as Array<{ id: string, kind: string }>) {
    if (e.kind === 'own') expect((await request.delete(`/api/schedules/library/${e.id}`)).ok()).toBe(true)
  }
  for (const s of (await (await request.get('/api/schedules')).json()) as Array<{ id: string, kind: string }>) {
    if (s.kind === 'pump' || s.id === LIGHT.id) expect((await request.delete(`/api/schedules/${s.id}`)).ok()).toBe(true)
  }
})

/** Nothing on the page spills out of its box, but names cut short on purpose (`truncate`), and the page never scrolls sideways. */
async function fits(page: Page, what: string, width: number) {
  const overflow = () => page.getByRole('main').evaluate(el => [...el.querySelectorAll('[data-testid="protocol"] *, [data-testid="your-schedules"] *, [data-testid="schedule-editor"] *')]
    .filter(e => e instanceof HTMLElement && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1 && !e.classList.contains('truncate') && getComputedStyle(e).overflowX !== 'hidden')
    .map(e => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className.toString().slice(0, 40)} ${e.scrollWidth}>${e.clientWidth}`))
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  expect(await overflow(), `overflow ${what} at ${width}px`).toEqual([])
  // Polled: a resize settles over a frame or two (the tank and the charts measure themselves after it).
  await expect.poll(sideways, { message: `page scrolls sideways ${what} at ${width}px` }).toBe(false)
}

test('water: builds a schedule, uses it, and the page never scrolls sideways', async ({ page }, info) => {
  // Four widths, three states each, measured and photographed.
  test.setTimeout(180_000)
  // A basil pod sown today under an open cycle, on germination's watering: the protocol card is the one watering.
  const today = new Date().toISOString().slice(0, 10)
  expect((await page.request.patch('/api/pods/1', { data: { plant: 'Basil', plantedAt: today, status: 'seeded' } })).ok()).toBe(true)
  expect((await page.request.post('/api/grow/start-germination', { headers: { 'content-type': 'application/json' } })).ok()).toBe(true)
  expect((await page.request.put(`/api/schedules/${LIGHT.id}`, { data: LIGHT })).ok()).toBe(true)
  await page.goto('/water')
  const main = page.getByRole('main')
  await expect(main.getByTestId('protocol')).toBeVisible()
  const list = main.getByTestId('your-schedules')
  await expect(list.getByText('Your schedules')).toBeVisible()

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 })
    await list.scrollIntoViewIfNeeded()
    await fits(page, 'with the protocol', width)
    await main.getByTestId('protocol').screenshot({ path: info.outputPath(`water-protocol-${width}.png`) })
    await list.screenshot({ path: info.outputPath(`water-schedules-${width}.png`) })
  }

  // A new schedule from the protocol's last stage, with a cycle added after lights off and moved back into the light.
  await list.getByRole('button', { name: 'New schedule' }).click()
  const editor = main.getByTestId('schedule-editor')
  await expect(editor.getByRole('heading', { name: 'New schedule' })).toBeVisible()
  await editor.getByLabel('Name').fill('Summer e2e')
  await editor.getByRole('button', { name: 'Add cycle' }).click()
  await editor.getByLabel('Cycle 4 time').fill('23:30')
  const dark = editor.getByTestId('editor-dark')
  await expect(dark).toContainText('23:30 is after lights off')
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 })
    await editor.scrollIntoViewIfNeeded()
    await fits(page, 'with a cycle after lights off', width)
    await editor.screenshot({ path: info.outputPath(`water-editor-dark-${width}.png`) })
  }
  // 20:00 is the Mature stage's own: the hour before it.
  await dark.getByRole('button', { name: 'Move to 19:00' }).click()
  await expect(dark).toHaveCount(0)
  await expect(editor.getByLabel('Cycle 4 time')).toHaveValue('19:00')
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 })
    await editor.scrollIntoViewIfNeeded()
    await fits(page, 'with the editor open', width)
    await editor.screenshot({ path: info.outputPath(`water-editor-${width}.png`) })
  }
  // Germination is watering, so the main button queues it for after the protocol; Save keeps it, and Use puts it on now.
  await expect(editor.getByRole('button', { name: 'Save & use after protocol' })).toBeVisible()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const row = list.getByTestId('schedule-row').filter({ hasText: 'Summer e2e' })
  await expect(row).toContainText('4 × 6 min · every day')
  await row.getByRole('button', { name: 'Use' }).click()

  // On your schedule now: the card opens on it, the protocol card steps aside.
  await expect(list.getByRole('heading', { name: 'On your schedule · Summer e2e' })).toBeVisible()
  await expect(main.getByTestId('protocol')).toHaveCount(0)
  await expect(row).toContainText('ACTIVE')
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 })
    await list.scrollIntoViewIfNeeded()
    await fits(page, 'on your schedule', width)
    await list.screenshot({ path: info.outputPath(`water-on-schedule-${width}.png`) })
  }

  // Back to the protocol is one click.
  await list.getByRole('button', { name: 'Back to the protocol' }).click()
  await expect(main.getByTestId('protocol')).toBeVisible()
  await expect(list.getByTestId('schedule-row').filter({ hasText: 'Germination' })).toContainText('ACTIVE')
})
