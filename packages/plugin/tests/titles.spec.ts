import { describe, expect, it } from 'vitest'
import { parseTitle } from '../src/host/titles.ts'

describe('a written title', () => {
  it('keeps the first line without heading marks, wrapping quotes or trailing punctuation', () => {
    expect(parseTitle('\n## “京都周末行程”。\nBecause it is about Kyoto')).toBe('京都周末行程')
    expect(parseTitle('"Weekend in Kyoto."')).toBe('Weekend in Kyoto')
  })
  it('is bounded to the length a chat title starts with, and absent when nothing is left', () => {
    expect(Array.from(parseTitle('长'.repeat(200))!)).toHaveLength(80)
    expect(parseTitle(' \n"" \n')).toBeUndefined()
  })
})
