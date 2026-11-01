import { expect, test } from '@playwright/test'

test('⌘K search opens from anywhere and jumps to a setting or a plant', async ({ page }) => {
  await page.request.patch('/api/pods/12', { data: { plant: 'Thai Basil', status: 'growing' } })
  await page.goto('/water')
  // The shortcut listens once the sidebar has mounted.
  await expect(page.getByRole('button', { name: 'Search' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const box = page.getByRole('combobox', { name: 'Search pages, settings, plants and rules' })
  await expect(box).toBeFocused()
  await box.fill('restore')
  await expect(page.getByRole('option').first()).toContainText('Backup')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/settings#backup$/)
  await expect(page.locator('#backup')).toBeInViewport()

  await page.getByRole('button', { name: 'Search' }).click()
  await box.fill('thai')
  await expect(page.getByRole('option').first()).toContainText('Grow › Pod 12')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/grow\?pod=12$/)
})
