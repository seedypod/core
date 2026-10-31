import { expect, test } from '@playwright/test'

test('sensors: add a pH probe, calibrate it, see it on the dashboard, remove it', async ({ page }) => {
  await page.goto('/sensors')
  await expect(page.getByText('Pump power monitor (INA219)')).toBeVisible()
  await expect(page.getByText('Built-in').first()).toBeVisible()

  await page.getByRole('button', { name: 'Add sensor' }).click()
  await page.getByRole('radio', { name: /pH probe/ }).click()
  await expect(page.getByLabel('I²C address')).toHaveValue('0x63')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('Added', { exact: true })).toBeVisible()

  // A second pH probe is refused by the daemon, with its reason.
  await page.getByRole('button', { name: 'Add sensor' }).click()
  await page.getByRole('radio', { name: /pH probe/ }).click()
  await page.getByLabel('I²C address').fill('0x65')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('a ph sensor is already installed')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Guided calibration: midpoint stored, optional points skipped.
  await page.getByRole('button', { name: 'Calibrate' }).click()
  await expect(page.getByText('Midpoint (pH 7)')).toBeVisible()
  await page.getByRole('button', { name: 'Store point' }).click()
  await page.getByRole('button', { name: 'Skip' }).click()
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByText(/holds 1 point/)).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()

  await page.goto('/')
  await expect(page.getByText('Water quality')).toBeVisible()

  await page.goto('/sensors')
  await page.getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('Added', { exact: true })).toHaveCount(0)
  await page.goto('/')
  await expect(page.getByText('Water quality')).toHaveCount(0)
})
