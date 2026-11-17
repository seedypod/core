import { describe, expect, it } from 'vitest'
import { planLayout } from '../planner'
import { slots } from '../zones'

const moves = (occupied: Record<number, string>, plants: { plantId: string, count: number }[] = [], overrides?: Parameters<typeof planLayout>[0]['overrides']) =>
  planLayout({ model: 'home', plants, occupied, overrides, suggestMoves: true }).moves

describe('suggested moves for planted pods', () => {
  it('are only worked out when asked for', () => {
    expect(planLayout({ model: 'home', plants: [], occupied: { 8: 'butterhead' } }).moves).toBeUndefined()
    expect(planLayout({ model: 'nursery', plants: [], occupied: { 1: 'basil' }, suggestMoves: true }).moves).toBeUndefined()
    expect(moves({})).toEqual([])
  })

  it('move pods outside their plant’s zones to free ideal pods, best first, and leave pods that are ok', () => {
    // Lettuce in high light, mint in high, basil in low (which it does ok in).
    expect(moves({ 8: 'butterhead', 11: 'mint', 1: 'basil' })).toEqual([
      { from: 11, to: 2, plantId: 'mint', plantName: 'Mint', toZone: 'low', swap: null, gain: 150, text: 'Move Mint from pod 11 to pod 2 — its ideal low light.' },
      { from: 8, to: 4, plantId: 'butterhead', plantName: 'Butterhead', toZone: 'medium', swap: null, gain: 100, text: 'Move Butterhead from pod 8 to pod 4 — its ideal medium light.' },
    ])
    expect(moves({ 1: 'basil', 4: 'jalapeno' })).toEqual([])
  })

  it('swap two planted pods, told from the side whose light improves more', () => {
    expect(moves({ 8: 'butterhead', 4: 'jalapeno' })).toMatchObject([{
      from: 4, to: 8, swap: { plantId: 'butterhead', plantName: 'Butterhead', existing: true }, gain: 125,
      text: 'Swap Jalapeño in pod 4 with Butterhead in pod 8 — Butterhead gets its ideal medium light.',
    }])
  })

  it('swap a planted pod with a planned one when the tower is full', () => {
    const r = moves({ 8: 'butterhead' }, [{ plantId: 'jalapeno', count: 12 }, { plantId: 'kale', count: 11 }, { plantId: 'chives', count: 6 }])
    expect(r).toMatchObject([{
      from: 8, to: 27, swap: { plantId: 'jalapeno', existing: false },
      text: 'Move Butterhead from pod 8 to pod 27 and plan Jalapeño in pod 8 instead — Butterhead gets its ideal medium light.',
    }])
  })

  it('give large plants room when crowding costs enough', () => {
    expect(moves({ 7: 'jalapeno', 8: 'jalapeno', 11: 'jalapeno' })).toMatchObject([{ from: 8, to: 13, gain: 90, text: 'Move Jalapeño from pod 8 to pod 13 — more room from the large plants around it.' }])
    // Two side by side cost less than the bar.
    expect(moves({ 7: 'jalapeno', 8: 'jalapeno' })).toEqual([])
  })

  it('never move a pin or a pod the catalog cannot name, and count a zone the plan allows as ok', () => {
    const better = slots('home').filter(s => s.zone !== 'high').map(s => s.slot)
    const occupied: Record<number, string> = { 8: 'butterhead', ...Object.fromEntries(better.filter(n => n % 2).map(n => [n, 'unknown:Weed'])) }
    const pins = better.filter(n => n % 2 === 0).map(slot => ({ slot, plantId: 'kale' }))
    expect(moves(occupied, [], { pins })).toEqual([])
    expect(moves({ 8: 'butterhead' }, [], { allowedZones: { butterhead: ['medium', 'high'] } })).toEqual([])
  })

  it('suggest at most three, each pod in one', () => {
    const full = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 1, ['butterhead', 'jalapeno', 'mint', 'basil', 'peas'][i % 5] as string]))
    const r = moves(full) ?? []
    expect(r).toHaveLength(3)
    const pods = r.flatMap(m => [m.from, m.to])
    expect(new Set(pods).size).toBe(pods.length)
    expect(r.map(m => m.gain)).toEqual([...r.map(m => m.gain)].sort((a, b) => b - a))
  })
})
