import { describe, expect, it } from 'vitest'
import { decodeBase64 } from '../src/host/base64.ts'

const limit = 1024
describe('bounded base64 decoding', () => {
  it('decodes every padding form back to the original bytes', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd']) expect(decodeBase64(Buffer.from(text).toString('base64'), limit)?.toString()).toBe(text)
  })
  it('rejects text that does not round-trip to canonical base64', () => {
    for (const value of ['not base64!', 'YWJj\n', 'YWI', 'YQ=', 'YR==', '-_-_', 'YWJj====']) expect(decodeBase64(value, limit)).toBeUndefined()
  })
  it('enforces the decoded byte limit exactly', () => {
    expect(decodeBase64(Buffer.alloc(limit).toString('base64'), limit)).toHaveLength(limit)
    expect(decodeBase64(Buffer.alloc(limit + 1).toString('base64'), limit)).toBeUndefined()
  })
  it('validates a default maximum upload without overflowing the stack', () => {
    const bytes = Buffer.alloc(64 * 1024 * 1024, 1)
    expect(decodeBase64(bytes.toString('base64'), bytes.length)?.equals(bytes)).toBe(true)
  })
})
