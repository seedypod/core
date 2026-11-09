import { expect, test } from '@playwright/test'

test('settings → updates: the channel sticks, and a check that can\'t reach GitHub says so', async ({ page }) => {
  await page.goto('/settings#update')
  const card = page.locator('#update')
  await expect(card.getByRole('heading', { name: 'Updates' })).toBeVisible()
  await card.getByRole('tab', { name: 'Stable' }).click()
  await expect.poll(async () => (await (await page.request.get('/api/update')).json()).channel).toBe('stable')
  await page.reload()
  await expect(card.getByRole('tab', { name: 'Stable' })).toHaveAttribute('aria-selected', 'true')
  await card.getByRole('button', { name: 'Check for updates' }).click()
  await expect(card.getByText(/^couldn't reach GitHub/)).toBeVisible()
  await card.getByRole('tab', { name: 'Dev' }).click()
  await expect.poll(async () => (await (await page.request.get('/api/update')).json()).channel).toBe('dev')
})
