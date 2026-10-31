import { describe, expect, it } from 'vitest'
import { openApiDocument } from '../openapi'

describe('OpenAPI document', () => {
  it('generates for every exposed procedure (each needs .output())', () => {
    const doc = openApiDocument('http://localhost:3000/api')
    const paths = Object.keys(doc.paths ?? {})
    expect(paths).toEqual(expect.arrayContaining(['/system', '/healthcheck', '/sensors', '/light', '/pump', '/pump/run-once', '/pump/stop', '/alerts']))
  })
})
