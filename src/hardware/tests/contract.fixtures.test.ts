import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ActuatorCommand, ActuatorState, Alert, CalibrationCommand, CalibrationResult, DeviceCommand, DeviceInventory, DeviceKindInfo, DeviceResult, Reading, SystemInfo } from '../contract'

const dir = join(__dirname, '../../../hal/contract/fixtures')
const schemas = { system: SystemInfo, actuator_state: ActuatorState, reading: Reading, alert: Alert, alert_dose_fault: Alert, command: ActuatorCommand, calibration_command: CalibrationCommand, calibration_result: CalibrationResult, device_inventory: DeviceInventory, device_kinds: z.array(DeviceKindInfo), device_command: DeviceCommand, device_result: DeviceResult } as const

describe('HAL contract fixtures parse on the TS side', () => {
  for (const file of readdirSync(dir)) {
    const name = file.replace(/\.json$/, '') as keyof typeof schemas
    it(`${file}`, () => {
      const schema = schemas[name]
      expect(schema, `no schema registered for fixture ${file}`).toBeDefined()
      const parsed = schema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')))
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true)
    })
  }
})
