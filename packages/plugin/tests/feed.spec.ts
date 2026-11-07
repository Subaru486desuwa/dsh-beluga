import { describe, expect, it } from 'vitest'
import { Feed } from '../src/host/feed.ts'

describe('bounded follow streams', () => {
  it('resynchronizes a slow reader and removes the subscription on abort', async () => {
    const feed = new Feed<number>()
    let current = 0
    const abort = new AbortController()
    const iterator = feed.follow(() => current, abort.signal)[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ value: 0, done: false })
    for (current = 1; current <= 100; current++) feed.publish(current)
    const next = await iterator.next()
    expect(next.value).toBeGreaterThanOrEqual(65)
    expect(feed.subscriberCount).toBe(1)
    abort.abort()
    expect((await iterator.next()).done).toBe(true)
    expect(feed.subscriberCount).toBe(0)
  })
  it('closes a pending read and never revives a disposed feed', async () => {
    const feed = new Feed<number>()
    const signal = new AbortController().signal
    const iterator = feed.follow(() => 1, signal)[Symbol.asyncIterator]()
    await iterator.next()
    const pending = iterator.next()
    feed.close()
    expect((await pending).done).toBe(true)
    expect((await feed.follow(() => 2, signal)[Symbol.asyncIterator]().next()).done).toBe(true)
  })
})
