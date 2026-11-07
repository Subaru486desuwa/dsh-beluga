/** Least-recently-used map bounded by total cost; a value above the bound is not kept. */
export class Lru<K, V> {
  private readonly values = new Map<K, { readonly value: V; readonly cost: number }>()
  private total = 0
  constructor(private readonly capacity: number, private readonly costOf: (value: V) => number) {}
  get(key: K): V | undefined {
    const item = this.values.get(key)
    if (!item) return undefined
    this.values.delete(key)
    this.values.set(key, item)
    return item.value
  }
  set(key: K, value: V): void {
    this.delete(key)
    const cost = this.costOf(value)
    if (cost > this.capacity) return
    this.values.set(key, { value, cost })
    this.total += cost
    for (const oldest of this.values.keys()) {
      if (this.total <= this.capacity) break
      this.delete(oldest)
    }
  }
  delete(key: K): void {
    const item = this.values.get(key)
    if (item) { this.values.delete(key); this.total -= item.cost }
  }
  clear(): void { this.values.clear(); this.total = 0 }
}
