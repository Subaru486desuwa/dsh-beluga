import { describe, expect, it } from 'vitest'
import remote from '../lib/typert.remote-client.js'

describe('published Remote contract', () => {
  it('exposes streaming methods and strict request validation', () => {
    expect(Object.keys(remote.methods)).toHaveLength(41)
    for (const name of ['apps', 'updateApps']) expect(remote.methods).toHaveProperty('personalChat/' + name)
    for (const name of ['refreshSummary', 'askSummary', 'editSummary', 'undoSummary', 'clearSummary', 'summaryOptions']) expect(remote.methods).toHaveProperty('personalChat/' + name)
    const edit = remote.methods['personalChat/editSummary'].input({ strict: true }).create()
    expect(() => edit.parse({ request: { text: 'x' } })).toThrow()
    expect(edit.parse({ request: { expectedRevision: 2, text: 'x' } })).toEqual({ request: { expectedRevision: 2, text: 'x' } })
    const ask = remote.methods['personalChat/askSummary'].input({ strict: true }).create()
    expect(() => ask.parse({ request: { text: 42 } })).toThrow()
    const options = remote.methods['personalChat/summaryOptions'].input({ strict: true }).create()
    expect(options.parse({ request: { sensitive: true } })).toEqual({ request: { sensitive: true } })
    expect(() => options.parse({ request: { sensitive: 'yes' } })).toThrow()
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
