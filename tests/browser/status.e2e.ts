import { expect, test } from '@playwright/test'

test('system → status lists the checks, disk space and the Home Assistant bridge', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('complementary').getByRole('link', { name: /^Status/ }).click()
  await expect(page).toHaveURL(/\/status$/)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Status' })).toBeVisible()
  const hardware = main.getByRole('region', { name: 'Hardware' })
  await expect(hardware.getByTestId('check-hal')).toContainText('Hardware daemon')
  await expect(hardware.getByTestId('check-hal')).toContainText('OK')
  await expect(main.getByTestId('check-bridge')).toContainText('No broker set')
  await expect(main.getByTestId('status-summary')).toContainText(/\d+\/\d+/)
  // DATA_DIR is a real directory on the runner, so statfs answers.
  await expect(main.getByRole('meter', { name: 'Disk used' })).toBeVisible()
  await expect(main.getByText(/No broker set\. Add one in Settings/)).toBeVisible()
})
