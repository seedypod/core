import { expect, test } from '@playwright/test'

test('settings → storage shows the SD card write meter', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('navigation').getByRole('button', { name: 'SD card' }).click()
  await expect(page).toHaveURL(/\/settings#storage$/)
  const card = page.getByRole('region', { name: 'SD card' })
  await expect(card).toBeInViewport()
  await expect(card.getByTestId('flash-rate')).toHaveText(/^[\d.]+ (kB|MB|GB)\/day$/)
  await expect(card.getByText(/average since boot/)).toBeVisible()
  await expect(card.getByText('Written since boot')).toBeVisible()
  await expect(card.getByText('mmcblk0 · 32.0 GB')).toBeVisible()
  await expect(card.getByText(/full-card writes a year/)).toBeVisible()
})
