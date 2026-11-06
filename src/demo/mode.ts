/** Apart from `link.ts`, so asking doesn't pull the demo's in-page server into a page's chunk. */
export function isDemo(): boolean {
  return import.meta.env.VITE_DEMO === '1'
}
