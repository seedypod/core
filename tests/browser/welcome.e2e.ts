import { expect, test } from '@playwright/test'
import { bundleEntries, collect, gzipTar } from '../../src/backup/bundle'

test('a fresh unit opens on Welcome, refuses a backup from newer software, and starts a new garden', async ({ page }) => {
  await page.request.patch('/api/settings', { data: { setupComplete: false } })
  await page.goto('/')
  await expect(page.getByText('Welcome to seedypod')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set up a new garden' })).toBeVisible()

  await page.getByRole('button', { name: 'Restore from a backup' }).click()
  await expect(page.getByLabel('Endpoint')).toBeVisible()
  const db = new TextEncoder().encode('SQLite format 3\0')
  const bytes = await collect(gzipTar(bundleEntries([{ name: 'seedypod.db', bytes: db }], {
    format: { name: 'seedypod-backup', version: 1 }, createdAt: '2026-10-31T03:00:00.000Z', unit: { id: 'kitchen', name: 'Kitchen' },
    core: { version: 'main@f00d123' }, hald: { version: null }, schema: { migrations: 999, tag: null }, photos: false, skipped: [],
  })))
  await page.getByLabel('Backup file').setInputFiles({ name: 'seedypod-backup-kitchen-20261031-030000.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from(bytes) })
  await page.getByRole('button', { name: 'Restore this file' }).click()
  await expect(page.getByText(/This backup was made by seedypod core main@f00d123 \(database schema 999\).*Install that version of core or newer first/)).toBeVisible()

  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Set up a new garden' }).click()
  await expect(page.getByTestId('tower-3d')).toBeVisible()
  expect((await (await page.request.get('/api/settings')).json()).setupComplete).toBe(true)
})
