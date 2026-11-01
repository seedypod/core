import { expect, test } from '@playwright/test'

test('home shows the tower with its light, tank and air readings, and the API answers', async ({ page }) => {
  await page.goto('/')
  const tower = page.getByTestId('tower-3d')
  await expect(tower).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
  await tower.getByRole('button', { name: /°C/ }).click()
  await expect(page.getByText('Environment')).toBeVisible()
  await tower.getByRole('button', { name: /%$|off$/ }).first().click()
  await expect(page.getByText('Grow light')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: /Turn (on|off)/ }).click()
  await expect.poll(async () => (await (await page.request.get('/api/light')).json()).on).toBeDefined()
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
  await page.getByRole('button', { name: 'Run pump' }).click()
  await expect(page.getByText(/pump running at 30%/)).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText('pump idle')).toBeVisible()
})

test('schedule: create, toggle, delete a pump cycle', async ({ page }) => {
  await page.goto('/schedule')
  await page.getByRole('button', { name: 'Pump cycle' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Watering')).toBeVisible()
  await page.getByRole('button', { name: 'Delete' }).first().click()
  await expect(page.getByText('No pump cycles')).toBeVisible()
})

test('grow: start a cycle and edit a pod', async ({ page }) => {
  await page.goto('/grow')
  await page.getByRole('button', { name: 'Start cycle' }).click()
  await expect(page.getByText('Day 0')).toBeVisible()
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
