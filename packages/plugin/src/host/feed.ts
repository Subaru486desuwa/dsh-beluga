/** Bounded per-subscriber queues; slow readers receive a fresh baseline. */
export class Feed<T> {
  private readonly listeners = new Set<(value: T | undefined) => void>()
  private closed = false

  get subscriberCount(): number { return this.listeners.size }
  publish(value: T): void {
    if (!this.closed) for (const listener of this.listeners) listener(value)
  }
  close(): void {
    this.closed = true
    for (const listener of this.listeners) listener(undefined)
    this.listeners.clear()
  }
  async *follow(baseline: () => T, signal: AbortSignal): AsyncIterable<T> {
    if (signal.aborted || this.closed) return
    let ended = false
    let wake: (() => void) | undefined
    const queue: T[] = []
    const receive = (value: T | undefined): void => {
      if (value === undefined) ended = true
      else if (queue.length >= 64) { queue.length = 0; queue.push(baseline()) }
      else queue.push(value)
      wake?.()
      wake = undefined
    }
    const abort = (): void => receive(undefined)
    this.listeners.add(receive)
    signal.addEventListener('abort', abort, { once: true })
    try {
      yield baseline()
      while (!ended) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>(resolve => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.listeners.delete(receive)
      queue.length = 0
    }
  }
}
