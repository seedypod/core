import { expect, test } from '@playwright/test'

test('autopilot: build a rule, see it in words, arm it, watch it take the light, switch Autopilot off', async ({ page }) => {
  await page.goto('/autopilot')
  await expect(page.getByText('Run log')).toBeVisible()

  await page.getByRole('button', { name: 'New rule' }).click()
  const dlg = page.getByRole('dialog', { name: 'New rule' })
  await dlg.getByPlaceholder('Dim when hot').fill('Light at 45 while warm')
  await dlg.getByLabel('Signal').selectOption('sensor.air_temp')
  await dlg.getByLabel('Operator').selectOption('>')
  await dlg.getByLabel('Value').fill('0')
  await dlg.getByLabel('Action', { exact: true }).selectOption('setLight')
  await dlg.getByLabel('Level %').fill('45')
  await expect(dlg.getByLabel('Rule preview')).toHaveText('Every 5 minutes, if air temperature is above 0 °C, set the light to 45 %. At most once every 30 min.')
  await dlg.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByText('Light at 45 while warm', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Dry run')).toBeVisible()
  await expect(page.getByText(/would fire ·/)).toBeVisible()

  await page.getByRole('button', { name: 'Arm' }).click()
  await expect(page.getByText('Armed')).toBeVisible()
  await expect(page.getByText(/Light: set by Light at 45 while warm · 45 %/)).toBeVisible()

  await page.getByLabel('Autopilot on').click()
  await expect(page.getByText(/Off: no rule runs/)).toBeVisible()
  await expect(page.getByText(/Light: set by/)).toHaveCount(0)
})
