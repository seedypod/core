import { expect, test } from '@playwright/test'

test('grow: the tower renders in 3D, a pod picked on it opens in the side panel', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.request.patch('/api/pods/5', { data: { plant: 'Cherry Tomato', status: 'attention', notes: 'leaf curl' } })
  await page.goto('/grow')
  const tower = page.getByTestId('tower-3d')
  await expect(tower).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
  await expect(tower.locator('canvas')).toBeVisible()
  await expect(page.getByText('Needs attention')).toBeVisible()

  // Hovering pods shows which one is under the pointer; scan until one answers.
  const box = await tower.boundingBox()
  if (!box) throw new Error('the tower has no size')
  let found = false
  for (let y = 0.1; y < 0.8 && !found; y += 0.03) {
    for (let x = 0.3; x < 0.7 && !found; x += 0.03) {
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y)
      found = await tower.getByRole('status').isVisible()
      if (found) await page.mouse.click(box.x + box.width * x, box.y + box.height * y)
    }
  }
  expect(found).toBe(true)
  // The click picked a pod: the side panel's picker now names one.
  await expect(page.getByLabel('Pod', { exact: true })).not.toHaveValue('0')

  await page.getByLabel('Pod', { exact: true }).selectOption('5')
  await expect(page.getByLabel('Notes')).toHaveValue('leaf curl')
  expect(errors).toEqual([])
})
