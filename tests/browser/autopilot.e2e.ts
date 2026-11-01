import { expect, test } from '@playwright/test'

test('autopilot: build a rule, see it in words, arm it, watch it take the light, switch Autopilot off', async ({ page }) => {
  await page.goto('/autopilot')
  await expect(page.getByText('Activity', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'New rule' }).click()
  const dlg = page.getByRole('dialog', { name: 'New rule' })
  await dlg.getByPlaceholder('Dim when hot').fill('Light at 45 while warm')
  await dlg.getByLabel('Signal').selectOption('sensor.air_temp')
  await dlg.getByLabel('Operator').selectOption('>')
  await dlg.getByLabel('Value').fill('0')
  await dlg.getByLabel('Action', { exact: true }).selectOption('setLight')
  await dlg.getByLabel('Level %').fill('45')
  await expect(dlg.getByLabel('Rule preview')).toHaveText('Every 5 minutes, if air temperature is above 0°C, set the light to 45%. At most once every 30 min.')
  await dlg.getByRole('button', { name: 'Save' }).click()

  const row = page.getByTestId(/^rule-/).filter({ hasText: 'Light at 45 while warm' })
  await expect(row).toBeVisible()
  const mode = row.getByRole('radiogroup', { name: 'Light at 45 while warm mode' })
  await expect(mode.getByRole('radio', { name: 'Dry-run' })).toHaveAttribute('aria-checked', 'true')
  // The standing backtest sits on the row, and the dry run's first evaluation lands in the log.
  await expect(row.getByTestId(/^backtest-/)).toContainText('7-day backtest')
  await expect(page.getByRole('list', { name: 'Run log' }).getByText('Would fire').first()).toBeVisible()

  await mode.getByRole('radio', { name: 'Active' }).click()
  await expect(mode.getByRole('radio', { name: 'Active' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText(/Light: set by Light at 45 while warm · 45%/)).toBeVisible()
  await expect(page.getByTestId('automations-status')).toHaveText('1 rule · 1 active')

  await page.getByLabel('Autopilot enabled').click()
  await expect(page.getByText(/^Autopilot is off\./)).toBeVisible()
  await expect(page.getByText(/Light: set by/)).toHaveCount(0)
})
