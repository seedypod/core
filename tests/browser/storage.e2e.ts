import { expect, test } from '@playwright/test'

test('settings → storage shows the SD card write meter', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByText('Storage', { exact: true })).toBeVisible()
  await expect(page.getByTestId('flash-rate')).toHaveText(/^[\d.]+ (kB|MB|GB)\/day$/)
  await expect(page.getByText(/average since boot/)).toBeVisible()
  await expect(page.getByText('Written since boot')).toBeVisible()
  await expect(page.getByText('mmcblk0 · 32.0 GB')).toBeVisible()
  await expect(page.getByText(/full-card writes a year/)).toBeVisible()
})
