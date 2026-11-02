import { expect, test } from '@playwright/test'

test('grow: the tower renders in 3D, a pod picked on it opens in the side panel', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.request.patch('/api/pods/5', { data: { plant: 'Cherry Tomato', status: 'attention', notes: 'leaf curl' } })
  await page.goto('/grow')
  await page.getByRole('tab', { name: 'Tower' }).click()
  const tower = page.getByTestId('tower-3d')
  await expect(tower).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
  await expect(tower.locator('canvas')).toBeVisible()
  await expect(page.getByText('Needs attention')).toBeVisible()

  // Hovering a pod previews its callout; scan until one answers.
  const box = await tower.boundingBox()
  if (!box) throw new Error('the tower has no size')
  let found = false
  for (let y = 0.1; y < 0.8 && !found; y += 0.03) {
    for (let x = 0.3; x < 0.7 && !found; x += 0.03) {
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y)
      found = await tower.getByTestId('pod-callout').isVisible()
      if (found) await page.mouse.click(box.x + box.width * x, box.y + box.height * y)
    }
  }
  expect(found).toBe(true)
  // The click picked a pod: the side panel now shows one.
  await expect(page.getByRole('complementary', { name: /^Pod \d+$/ })).toBeVisible()

  await page.getByRole('tab', { name: 'Pods' }).click()
  await page.getByRole('button', { name: '5 Cherry Tomato', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Pod 5' })).toBeVisible()
  await expect(page.getByLabel('Notes')).toHaveValue('leaf curl')
  expect(errors).toEqual([])
})

test('home: hovering a pod previews its callout, a click pins it, and its close button unpins it', async ({ page }) => {
  await page.request.patch('/api/pods/5', { data: { plant: 'Cherry Tomato', status: 'attention', notes: 'leaf curl' } })
  await page.goto('/')
  const tower = page.getByTestId('tower-3d')
  await expect(tower).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
  const callout = tower.getByTestId('pod-callout')
  // The pod sits below and left of its flag; search around there until it answers a hover.
  const flag = await tower.getByRole('button', { name: 'Pod 5: Needs attention' }).boundingBox()
  if (!flag) throw new Error('no flag on pod 5')
  const near = { x: flag.x + flag.width / 2 - 22, y: flag.y + flag.height / 2 + 22 }
  let at: { x: number, y: number } | null = null
  for (let dy = -12; dy <= 30 && !at; dy += 3) {
    for (let dx = -18; dx <= 18 && !at; dx += 3) {
      await page.mouse.move(near.x + dx, near.y + dy)
      if (await callout.isVisible()) at = { x: near.x + dx, y: near.y + dy }
    }
  }
  if (!at) throw new Error('pod 5 did not answer a hover')
  await expect(callout).toHaveAttribute('data-state', 'hover')
  await expect(callout).toContainText('Click to pin')
  await page.mouse.click(at.x, at.y)
  // Pinned, it stays once the pointer leaves the pod, with what to do about it.
  const box = await tower.boundingBox()
  if (!box) throw new Error('the tower has no size')
  await page.mouse.move(box.x + 8, box.y + box.height - 8)
  await expect(callout).toHaveAttribute('data-state', 'pinned')
  await expect(callout).toContainText('leaf curl')
  await expect(callout.getByRole('link', { name: 'View photo' })).toHaveAttribute('href', '/cameras')
  await callout.getByRole('button', { name: 'Close pod 5' }).click()
  await expect(callout).toBeHidden()
})

test('home: the light-zone toggle colours the pods by zone and names the model', async ({ page }, info) => {
  await page.goto('/')
  const tower = page.getByTestId('tower-3d')
  await expect(tower).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
  await tower.getByRole('button', { name: 'Light zones' }).click()
  await expect(tower.getByTestId('zone-legend')).toContainText('Gardyn Home')
  await expect(tower.getByTestId('zone-legend')).toContainText('Low light · Top and bottom rows across the columns')
  await tower.screenshot({ path: info.outputPath('light-zones.png') })
  await page.reload()
  await expect(tower.getByRole('button', { name: 'Light zones' })).toHaveAttribute('aria-pressed', 'true')
})
