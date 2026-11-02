import { expect, test } from '@playwright/test'

test('settings → Apple Home: off by default, on shows the setup code and QR, off again', async ({ page }) => {
  await page.goto('/settings')
  const main = page.getByRole('main')
  const toggle = main.getByRole('switch', { name: 'HomeKit' })
  await expect(main.getByRole('heading', { name: 'Apple Home' })).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(main.getByTestId('homekit-code')).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(main.getByTestId('homekit-code')).toHaveText(/^\d{3}-\d{2}-\d{3}$/)
  await expect(main.getByAltText('HomeKit setup code QR')).toBeVisible()
  await expect(main.getByTestId('homekit-paired')).toHaveText('no')
  const status = await (await page.request.get('/api/homekit')).json() as { running: boolean, setupURI: string }
  expect(status.running).toBe(true)
  expect(status.setupURI).toMatch(/^X-HM:\/\/[0-9A-Z]{13}$/)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(main.getByTestId('homekit-code')).toHaveCount(0)
})
