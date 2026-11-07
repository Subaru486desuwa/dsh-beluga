/** Deliberately small user-prepared memory migration format, not an assumed provider export schema. */
import type { Memory } from '../shared/types.ts'

/** @param fileName - Explicitly chosen input filename. @param text - Original file text. @returns independently reviewable candidate records. */
export function parseMemoryImport(fileName: string, text: string): readonly { text: string; category: Memory['category'] }[] {
  if (!fileName.toLowerCase().endsWith('.json')) return [{ text, category: 'fact' }]
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('Expected an array of memory strings or records')
  return parsed.map((item: unknown) => {
    if (typeof item === 'string') return { text: item, category: 'fact' }
    if (typeof item !== 'object' || item === null || !('text' in item) || typeof item.text !== 'string') throw new Error('Expected memory text')
    const category = 'category' in item ? item.category : 'fact'
    if (category !== 'fact' && category !== 'preference' && category !== 'decision') throw new Error('Unknown memory category')
    return { text: item.text, category }
  })
}
