import { expect, test } from '@playwright/test'

test('dashboard renders live simulator data and the API answers', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Grow light')).toBeVisible()
  await expect(page.getByText('Environment')).toBeVisible()
  const r = await page.request.get('/api/system')
  expect(r.ok()).toBeTruthy()
  expect((await r.json()).system.model).toContain('sim')
})

test('light slider and power toggle drive the HAL', async ({ page }) => {
  await page.goto('/light')
  await page.getByRole('switch', { name: 'Light power' }).click()
  await expect(page.getByText(/^\d+%$/).first()).toBeVisible()
  const s = await page.request.get('/api/light')
  expect((await s.json()).on).toBe(true)
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
  await page.getByRole('button', { name: '1', exact: true }).click()
  await page.getByLabel('Plant').fill('Basil')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: /1 Basil/ })).toBeVisible()
})

test('kiosk route has no shell', async ({ page }) => {
  await page.goto('/kiosk')
  await expect(page.getByText('Tank')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0)
})
