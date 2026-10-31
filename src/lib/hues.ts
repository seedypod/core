/**
 * Hue helpers for the card backdrops (ported from sleepypod's tempColors).
 */

/**
 * Sky hue for a time of day (minutes past midnight) — the card's upper wash:
 * deep indigo at night, rose-amber at dawn, pale sky by day, violet at dusk.
 */
export function skyHue(minutes: number): number {
  const m = ((minutes % 1440) + 1440) % 1440
  const stops: [number, number][] = [
    [0, 235], [300, 240], [390, 15], [480, 205], [1020, 205], [1140, 290], [1290, 235], [1440, 235],
  ]
  for (let i = 0; i < stops.length - 1; i++) {
    const [m0, h0] = stops[i]
    const [m1, h1] = stops[i + 1]
    if (m >= m0 && m <= m1) {
      let d = h1 - h0
      if (d > 180) d -= 360
      if (d < -180) d += 360
      return Math.round((h0 + d * ((m - m0) / (m1 - m0)) + 360) % 360)
    }
  }
  return 235
}

/**
 * Glow hue for grow-light brightness 0–100: dim amber at low levels through
 * warm white to a cool daylight tint at full power.
 */
export function lightHue(brightness: number): number {
  const b = Math.max(0, Math.min(100, brightness)) / 100
  return Math.round(40 + b * 20)
}
