import { describe, expect, it } from 'vitest'
import { Lru } from '../src/host/lru.ts'

describe('bounded cache', () => {
  it('evicts the least recently used values once the total cost is exceeded', () => {
    const cache = new Lru<string, number>(10, value => value)
    cache.set('a', 4); cache.set('b', 4)
    expect(cache.get('a')).toBe(4)
    cache.set('c', 4)
    expect(cache.get('b')).toBeUndefined()
    expect([cache.get('a'), cache.get('c')]).toEqual([4, 4])
  })
  it('replaces a key at its new cost and refuses a value above the bound', () => {
    const cache = new Lru<string, number>(10, value => value)
    cache.set('a', 4); cache.set('a', 8); cache.set('b', 2)
    expect([cache.get('a'), cache.get('b')]).toEqual([8, 2])
    cache.set('huge', 11)
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.get('a')).toBe(8)
    cache.set('a', 11)
    expect(cache.get('a')).toBeUndefined()
  })
})
