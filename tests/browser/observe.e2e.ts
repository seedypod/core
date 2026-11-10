import { expect, test } from '@playwright/test'

test('cameras: a failed capture shows the failure with Retry, and raises an alert that links back', async ({ page }) => {
  // The sim camera returns a 4-byte stub, which the server rejects as no image.
  await page.goto('/cameras')
  const main = page.getByRole('main')
  const upper = main.getByTestId('camera-upper')
  await expect(main.getByText(/Timelapse every \d+ min/)).toBeVisible()
  // A retried run starts with the first run's failure, so either button may show.
  await upper.getByRole('button', { name: /^(Capture now|Retry)$/ }).click()
  await expect(upper.getByText(/^capture failed ·/)).toBeVisible()
  await expect(upper.getByText(/Last capture returned 4 bytes/)).toBeVisible()
  await expect(upper.getByTestId('failed-capture')).toBeVisible()
  await expect(upper.getByRole('button', { name: 'Retry' })).toBeVisible()

  await page.goto('/alerts')
  await expect(main.getByText(/\d+ open · .*\d+ hardware/)).toBeVisible()
  const alert = main.getByTestId('alert-camera_missing')
  await expect(alert.getByText('Upper camera not capturing')).toBeVisible()
  await expect(alert.getByText('Clearing it re-enables the camera. Fix the cause first.')).toBeVisible()
  await alert.getByRole('link', { name: 'View camera' }).click()
  await expect(page).toHaveURL(/\/cameras$/)

  await page.goto('/alerts')
  await main.getByTestId('alert-camera_missing').getByRole('button', { name: 'Clear fault' }).click()
  await expect(main.getByTestId('alert-camera_missing')).toHaveCount(0)
  await main.getByRole('tab', { name: 'History' }).click()
  await expect(main.getByText(/cleared by you/).first()).toBeVisible()
})

test('analysis: the dataset export opens from the header', async ({ page }) => {
  await page.goto('/analysis')
  await page.getByRole('button', { name: 'Export dataset' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export a dataset' })
  await expect(dialog.getByRole('tab', { name: '30 days' })).toBeVisible()
  await expect(dialog.getByRole('link')).toHaveAttribute('href', /\/api\/datasets\/export\?/)
})
