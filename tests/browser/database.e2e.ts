import { expect, test } from '@playwright/test'

test('settings → SD card opens the database view, scanned on the bundled worker', async ({ page }) => {
  await page.goto('/settings#storage')
  await page.getByRole('region', { name: 'SD card' }).getByRole('link', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/database$/)
  const main = page.getByRole('main')
  await expect(main.getByTestId('scanned')).toContainText('e2e.db · scanned')
  await expect(main.getByText('WAL', { exact: true }).first()).toBeVisible()
  await expect(main.getByTestId('table-telemetry')).toBeVisible()
  await expect(main.getByTestId('card-writes')).toContainText('The whole card takes')
  await main.getByRole('button', { name: 'Check integrity' }).click()
  await expect(main.getByText(/quick_check · /)).toBeVisible()
  await expect(main.getByText('OK', { exact: true })).toBeVisible()
})
