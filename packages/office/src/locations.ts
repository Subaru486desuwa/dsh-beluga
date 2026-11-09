/**
 * Where a paragraph sits in a Word part. Reading writes the short form, `t2.r3.c1.p1`: each step is an
 * element and its 1-based place among the siblings of that name, counted from the part's body. Earlier
 * versions wrote the long form, `/document[1]/body[1]/table[2]/row[3]/cell[1]/paragraph[1]`, counted from
 * the part's root; models may still repeat it from older chats, so both resolve.
 */
const SHORT: Readonly<Record<string, string>> = { p: 'p', tbl: 't', tr: 'r', tc: 'c' }
const LONG: Readonly<Record<string, string>> = { p: 'paragraph', tbl: 'table', tr: 'row', tc: 'cell' }
const tagFor = (labels: Readonly<Record<string, string>>, label: string): string => Object.keys(labels).find(tag => labels[tag] === label) ?? label

/** One step of a short location, for the element `tag` that is the `index`-th of its name. */
export const shortStep = (tag: string, index: number): string => (SHORT[tag] ?? tag) + index

export interface Step { readonly tag: string; readonly index: number }
/** @returns the steps, and whether they count from the part's body (short form) or its root (long form); undefined when malformed. */
export function parseLocation(location: string): { readonly steps: readonly Step[]; readonly fromBody: boolean } | undefined {
  const long = location.startsWith('/')
  const steps: Step[] = []
  // The long form tolerates the empty steps it always had around its slashes; the short form has none.
  for (const step of long ? location.split('/').filter(Boolean) : location.split('.')) {
    const match = long ? /^(.+)\[([1-9]\d*)\]$/u.exec(step) : /^([A-Za-z]+)([1-9]\d*)$/u.exec(step)
    if (!match) return undefined
    steps.push({ tag: tagFor(long ? LONG : SHORT, match[1]!), index: Number(match[2]) })
  }
  return steps.length ? { steps, fromBody: !long } : undefined
}
