import { expect, test } from '@playwright/test'

test('settings → backup downloads a bundle and records it as an off-card backup', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByTestId('backup-last')).toHaveText('none yet')
  await expect(page.getByText('The file holds your bucket secret and MQTT password. Keep it somewhere private.')).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()])
  expect(download.suggestedFilename()).toMatch(/^seedypod-backup-sim-0001-\d{8}-\d{6}\.tar\.gz$/)
  expect(await download.failure()).toBeNull()
  await expect.poll(async () => (await (await page.request.get('/api/backup')).json()).lastSuccess?.destination).toBe('download')
  await page.reload()
  await expect(page.getByTestId('backup-last')).toHaveText(/· downloaded$/)
  await expect(page.getByRole('button', { name: 'Back up now' })).toBeDisabled()
})
