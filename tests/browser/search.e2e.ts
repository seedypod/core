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
  await expect(page.getByRole('listbox').getByRole('option').first()).toContainText('Backup')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/settings#backup$/)
  await expect(page.locator('#backup')).toBeInViewport()

  await page.getByRole('button', { name: 'Search' }).click()
  await box.fill('thai')
  await expect(page.getByRole('listbox').getByRole('option').first()).toContainText('Grow › Pod 12')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/grow\?pod=12$/)
})

test('⌘K search finds the bundled docs offline and opens a guide in a new tab', async ({ page, context }) => {
  // Units often have no internet: the live index fails, so the palette searches its bundled snapshot.
  await context.route('https://seedypod.github.io/search-index.json', route => route.abort('internetdisconnected'))
  await context.route('https://seedypod.github.io/core/debugging/', route => route.fulfill({ contentType: 'text/html', body: '<title>Debugging</title>' }))
  await page.goto('/water')
  await page.getByRole('button', { name: 'Search' }).click()
  const palette = page.getByRole('dialog', { name: 'Search' })
  await palette.getByRole('combobox', { name: 'Search pages, settings, plants and rules' }).fill('debugging')
  const result = palette.getByRole('option').first()
  await expect(result).toContainText('Docs › User guide')
  await expect(result).toContainText('Opens the docs in a new tab')
  const popupEvent = page.waitForEvent('popup')
  await page.keyboard.press('Enter')
  const popup = await popupEvent
  await expect(popup).toHaveURL('https://seedypod.github.io/core/debugging/')
  await popup.close()
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/\/water$/)
})

test('⌘K search survives its chunk failing to load, and retries for real', async ({ page }) => {
  let down = true
  await page.route('**/assets/PaletteBody-*.js', route => (down ? route.abort('connectionfailed') : route.continue()))
  await page.goto('/water')
  await page.getByRole('button', { name: 'Search' }).click()
  const palette = page.getByRole('dialog', { name: 'Search' })
  await expect(palette.getByRole('alert')).toContainText('Search didn\'t load')
  // The page behind it is untouched, and the dialog closes.
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  // The page's title: the protocol card on it has a Water column too.
  await expect(page.getByRole('main').getByRole('heading', { name: 'Water', level: 1 })).toBeVisible()

  await page.getByRole('button', { name: 'Search' }).click()
  await palette.getByRole('button', { name: 'Try again' }).click()
  await expect(palette.getByRole('alert')).toContainText('Search didn\'t load')
  down = false
  await palette.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('combobox', { name: 'Search pages, settings, plants and rules' })).toBeFocused()
})
