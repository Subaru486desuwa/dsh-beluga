import { describe, expect, it } from 'vitest'
import remote from '../lib/typert.remote-client.js'

describe('published Remote contract', () => {
  it('exposes streaming methods and strict request validation', () => {
    expect(Object.keys(remote.methods)).toHaveLength(31)
    expect(remote.methods['personalChat/follow'].mode).toBe('stream')
    expect(remote.methods['personalChat/followConversation'].mode).toBe('stream')
    const input = remote.methods['personalChat/create'].input({ strict: true }).create()
    expect(input.parse({ request: { temporary: true } })).toEqual({ request: { temporary: true } })
    expect(() => input.parse({ request: { temporary: 'true' } })).toThrow()
    expect(() => input.parse({ request: { temporary: true, injected: true } })).toThrow()
    expect(remote.methods['personalChat/follow'].result.create().parse({ kind: 'baseline' })).toEqual({ kind: 'baseline' })
    expect(() => remote.methods['personalChat/follow'].result.create().parse({ kind: 'unknown' })).toThrow()
  })
})
