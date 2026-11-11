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

test('light slider and power toggle drive the HAL', async ({ page }) => {
  // Start from off: an earlier test may have left the light on.
  await page.request.post('/api/light', { data: { on: false } })
  await page.goto('/light')
  await page.getByRole('switch', { name: 'Light power' }).click()
  await expect.poll(async () => (await (await page.request.get('/api/light')).json()).on).toBe(true)
  await expect(page.getByRole('switch', { name: 'Light power' })).toHaveAttribute('aria-checked', 'true')
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

test('water: create, toggle, delete a pump cycle', async ({ page }) => {
  await page.goto('/water')
  const main = page.getByRole('main')
  // The starting points are always there; Add custom cycle opens the editor.
  await main.getByRole('button', { name: 'Add custom cycle' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(main.getByText('Watering', { exact: true })).toBeVisible()
  const toggle = main.getByRole('switch', { name: 'Enable Watering' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await main.getByRole('button', { name: 'Edit Watering' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(main.getByTestId('pump-preset-seedlings')).toBeVisible()
  await expect(page.getByTestId('pump-strip').getByText('No watering schedule')).toBeVisible()
})

test('old /schedule links land on Light, where the curves are', async ({ page }) => {
  await page.goto('/schedule')
  await expect(page).toHaveURL(/\/light$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Curves' })).toBeVisible()
})

test('grow: start a cycle and edit a pod', async ({ page }) => {
  await page.goto('/grow')
  await page.getByRole('button', { name: 'Start cycle' }).click()
  await expect(page.getByRole('main').getByText('Day 0')).toBeVisible()
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
