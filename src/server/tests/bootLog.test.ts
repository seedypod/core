import { describe, expect, it } from 'vitest'
import { summariseBootLog } from '../bootLog'

const boot = (hub: string) => `2026-11-07T04:42:17Z clock=synced up=92 boot=ab12cd34 core_s=41 hub=${hub} hprt0=0x00001c00 cameras=0 reboots=2 clean=1 temp=48.3 errors=3 outcome=reboot`

describe('summariseBootLog', () => {
  it('counts how often the hub came up by itself', () => {
    expect(summariseBootLog(`${[boot('0'), boot('1'), boot('0')].join('\n')}\n`)).toEqual({ boots: 3, hub: { up: 1, of: 3 } })
  })

  it('judges recent boots, so a cable swap shows, but counts them all', () => {
    const lines = [...Array.from({ length: 30 }, () => boot('0')), ...Array.from({ length: 20 }, () => boot('1'))]
    expect(summariseBootLog(lines.join('\n'))).toEqual({ boots: 50, hub: { up: 20, of: 20 } })
  })

  it('leaves out boots that say nothing about the hub', () => {
    expect(summariseBootLog([boot('-'), boot('1')].join('\n'))).toEqual({ boots: 2, hub: { up: 1, of: 1 } })
    expect(summariseBootLog(boot('-'))).toEqual({ boots: 1, hub: null })
  })

  it('copes with an empty file and a line with fields it doesn\'t know', () => {
    expect(summariseBootLog('')).toEqual({ boots: 0, hub: null })
    expect(summariseBootLog('t newfield=1 hub=1 another=x\n')).toEqual({ boots: 1, hub: { up: 1, of: 1 } })
  })
})
