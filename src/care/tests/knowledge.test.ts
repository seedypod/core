import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { anchor, CITE, cite, EC_TARGETS, PH_RANGE, REFRESH_DAYS, REFRESH_FRUITING_DAYS, SPROUT_DOSE_DAYS, TANK_MIN_PCT, TOP_OFF_DAYS } from '../knowledge'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const note = (path: string) => readFileSync(`${ROOT}${path}`, 'utf8')

describe('knowledge citations (ADR-0029)', () => {
  it('cites notes that exist, under headings they have, linked by GitHub\'s anchor', () => {
    for (const c of Object.values(CITE)) {
      const headings = note(c.note).split('\n').filter(l => /^#{1,6} /.test(l)).map(l => l.replace(/^#+ /, '').trim())
      expect(headings, `${c.note} has "${c.section}"`).toContain(c.section)
      expect(c.url).toBe(`https://github.com/seedypod/core/blob/dev/${c.note}#${anchor(c.section)}`)
    }
  })

  it('makes anchors as GitHub does', () => {
    expect(anchor('pH and EC')).toBe('ph-and-ec')
    expect(anchor('Doses owners use on a Gardyn')).toBe('doses-owners-use-on-a-gardyn')
    expect(anchor(' A heading: with (punctuation)! ')).toBe('a-heading-with-punctuation')
    expect(cite('knowledge/x.md', 'Plant food').url).toMatch(/#plant-food$/)
  })

  it('states only numbers the cited notes give', () => {
    const gardyn = note(CITE.phEc.note)
    expect(gardyn).toContain('keep the tank at least half full')
    expect(TANK_MIN_PCT).toBe(50)
    expect(gardyn).toMatch(/Top off to full with water and plant food \| weekly/)
    expect(TOP_OFF_DAYS).toBe(7)
    expect(gardyn).toContain(`the app counts ${REFRESH_DAYS} days`)
    expect(gardyn).toContain(`every ${REFRESH_FRUITING_DAYS} days with four or more fruiting plants`)
    expect(gardyn).toContain('usually within 2 weeks')
    expect(SPROUT_DOSE_DAYS).toBe(14)
    expect(gardyn).toContain(`| Leafy greens | ${PH_RANGE.min}–${PH_RANGE.max} |`)
    for (const [crop, row] of [['Seedlings', EC_TARGETS.seedlings], ['Leafy greens', EC_TARGETS['leafy greens']], ['Herbs', EC_TARGETS.herbs]] as const) {
      expect(gardyn, crop).toMatch(new RegExp(`\\| ${crop} \\|[^\\n]*\\| ${row.min.toFixed(1)}–${row.max.toFixed(1)} \\|`))
    }
    expect(gardyn).toContain(`${EC_TARGETS['fruiting crops'].min.toFixed(1)}–${EC_TARGETS['fruiting crops'].max.toFixed(1)} (tomatoes)`)
    // The doses the feed chore quotes for Gardyn Plant Food.
    for (const dose of ['1/4 tsp per gallon', '1/2 tsp per gallon', '1 tsp per gallon']) expect(gardyn).toContain(dose)
    // Cleaning has no published interval, which the clean chore says.
    expect(gardyn).toContain('| Light and deep cleaning | no fixed interval published |')
    expect(note(CITE.dosesByProduct.note)).toContain('Teaspoon doses are not interchangeable between products')
  })
})
