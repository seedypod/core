import { expect, test } from '@playwright/test'

test('system → status: live pill, health strip, today timeline and the three cards', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('complementary').getByRole('link', { name: /^Status/ }).click()
  await expect(page).toHaveURL(/\/status$/)
  const main = page.getByRole('main')
  await expect(main.getByText('System /')).toBeVisible()
  await expect(main.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible()

  // The simulator ticks every second, so the pill goes live and the age stays fresh.
  const pill = main.getByTestId('live-pill')
  await expect(pill.getByText('8 sensors')).toBeVisible()
  await expect(pill.getByText(/^reading age \d+(\.\d)?s$/)).toBeVisible()
  await expect(pill.getByText(/^\d+(\.\d)? Hz$/)).toBeVisible({ timeout: 10_000 })
  await pill.getByRole('button', { name: 'Pause' }).click()
  await expect(pill.getByText('PAUSED')).toBeVisible()
  await pill.getByRole('button', { name: 'Resume' }).click()

  const health = main.getByRole('region', { name: 'Health' })
  await expect(health.getByLabel(/checks passing/)).toHaveText(/^\d+\/\d+$/)
  await expect(health.getByText(/^hald .+ · v1$/)).toBeVisible()
  // DATA_DIR is a real directory on the runner, so statfs answers.
  await expect(health.getByRole('meter', { name: 'SD card used' })).toBeVisible()

  const today = main.getByRole('region', { name: 'Today' })
  for (const lane of ['Light', 'Water', 'Air', 'Events']) await expect(today.getByRole('group', { name: lane })).toBeVisible()
  await expect(today.getByText('now', { exact: true })).toBeVisible()

  await expect(main.getByRole('link', { name: 'Light' })).toHaveAttribute('href', '/light')
  await expect(main.getByRole('link', { name: 'Water' })).toHaveAttribute('href', '/water')
  await expect(main.getByRole('link', { name: 'Climate' })).toHaveAttribute('href', '/sensors')
})
