import { expect, test } from '@playwright/test'

test('home shows the tower with the cycle and pod counts over it, and the API answers', async ({ page }) => {
  await page.goto('/')
  const tower = page.getByTestId('tower-3d')
  await expect(tower).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
  await expect(tower.getByTestId('home-counts')).toContainText(/\d+ growing\d+ ready\d+ attention\d+ empty/)
  await expect(tower.getByText('Click a pod · drag to turn · ⌘-scroll to zoom')).toBeVisible()
  const r = await page.request.get('/api/system')
  expect(r.ok()).toBeTruthy()
  expect((await r.json()).system.model).toContain('sim')
})

test('the light slider turns the light on from 0 and off back at 0', async ({ page }) => {
  // Start from off: an earlier test may have left the light on.
  await page.request.post('/api/light', { data: { on: false } })
  await page.goto('/light')
  const slider = page.getByLabel('Brightness')
  await expect(slider).toHaveValue('0')
  await slider.press('ArrowRight')
  await expect.poll(async () => (await (await page.request.get('/api/light')).json()).on).toBe(true)
  await expect(page.getByTestId('strip-level')).toHaveText('5%')
  await slider.press('ArrowLeft')
  await expect.poll(async () => (await (await page.request.get('/api/light')).json()).on).toBe(false)
  await expect(page.getByTestId('strip-level')).toHaveText('Off')
})

test('Auto switches from the strip, running its curve alone, and off brings the others back', async ({ page }) => {
  await page.goto('/light')
  const auto = page.getByTestId('light-strip').getByRole('switch', { name: 'Auto', exact: true })
  const lightCurves = async () => ((await (await page.request.get('/api/schedules')).json()) as Array<{ id: string, kind: string, enabled: boolean, spec: { sun?: { auto?: boolean } } }>).filter(s => s.kind === 'light')
  const before = (await lightCurves()).filter(s => s.enabled && !s.spec.sun?.auto).map(s => s.id)
  if ((await auto.getAttribute('aria-checked')) === 'true') {
    await auto.click()
    await expect(auto).toHaveAttribute('aria-checked', 'false')
  }
  await auto.click()
  await expect(auto).toHaveAttribute('aria-checked', 'true')
  await expect.poll(async () => (await lightCurves()).filter(s => s.enabled).map(s => s.spec.sun?.auto)).toEqual([true])
  await auto.click()
  await expect(auto).toHaveAttribute('aria-checked', 'false')
  await expect.poll(async () => (await lightCurves()).filter(s => s.enabled && !s.spec.sun?.auto).map(s => s.id).sort()).toEqual([...before].sort())
})

test('pump run is bounded and reported', async ({ page }) => {
  await page.goto('/water')
  const strip = page.getByTestId('pump-strip')
  await strip.getByRole('radio', { name: '1 min' }).click()
  await strip.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByText(/watering at 30%/)).toBeVisible()
  await expect(strip).toHaveAttribute('data-state', 'running')
  await expect(strip.getByTestId('run-left')).toHaveText(/^\d+:\d\d$/)
  await strip.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText(/^pump idle/)).toBeVisible()
  await expect(strip.getByText('Pump idle')).toBeVisible()
})

test('water: use a preset, add a one-off cycle by hand, and it reads as Edited', async ({ page }) => {
  await page.goto('/water')
  const main = page.getByRole('main')
  await expect(page.getByTestId('pump-strip').getByText('No watering schedule')).toBeVisible()
  // The protocol's last stage is always there to use.
  const list = main.getByTestId('your-schedules')
  const mature = list.getByTestId('schedule-row').filter({ hasText: 'Mature greens & herbs' })
  await mature.getByRole('button', { name: 'Use' }).click()
  await expect(mature).toContainText('ACTIVE')
  await mature.getByRole('button', { name: 'More for Mature greens & herbs' }).click()
  await page.getByRole('menuitem', { name: 'Adjust the cycles' }).click()
  const editor = main.getByTestId('schedule-editor')
  await editor.getByRole('button', { name: 'Add cycle' }).click()
  await editor.getByRole('button', { name: 'Apply' }).click()
  await expect(list.getByTestId('schedule-edited')).toContainText('4 × 6 min · every day')
  await expect(page.getByTestId('pump-strip').getByText('No watering schedule')).toHaveCount(0)
  // Back to no pump cycles, as the other specs expect.
  for (const s of (await (await page.request.get('/api/schedules')).json()) as Array<{ id: string, kind: string }>) {
    if (s.kind === 'pump') expect((await page.request.delete(`/api/schedules/${s.id}`)).ok()).toBe(true)
  }
})

test('old /schedule links land on Light, where the curves are', async ({ page }) => {
  await page.goto('/schedule')
  await expect(page).toHaveURL(/\/light$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Curves' })).toBeVisible()
})

test('grow: start a cycle and edit a pod', async ({ page }) => {
  await page.goto('/grow')
  await page.getByRole('button', { name: 'Start cycle' }).click()
  await expect(page.getByRole('region', { name: 'Cycle' }).getByText('Day 0', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '1 empty', exact: true }).click()
  await page.getByLabel('Plant').fill('Basil')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: '1 Basil', exact: true })).toBeVisible()
})

test('kiosk route has no shell', async ({ page }) => {
  await page.goto('/kiosk')
  await expect(page.getByText('Tank')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0)
})
