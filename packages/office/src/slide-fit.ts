/**
 * How much text a slide region holds, so the engine can pick a size that needs no autofit, which only some
 * applications apply. Estimates err wide and tall: text found to fit does fit.
 */
/** East Asian characters, and the full-width forms and punctuation set among them, take a whole em. */
const WIDE = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\u3000-\\u303f\\uff01-\\uff60\\uffe0-\\uffe6'
const WIDE_CHARACTER = new RegExp('[' + WIDE + ']', 'u')
/** What a line breaks between: one wide character, or a word of other characters with the spaces after it. */
const TOKENS = new RegExp('[' + WIDE + ']|[^\\s' + WIDE + ']+\\s*|\\s+', 'gu')
/** Calibri's characters average under this; its digits take 0.51 em. */
const NARROW_EM = 0.55
/** Microsoft YaHei sets a line at about 1.32 em, Calibri at 1.22. */
export const LINE_EM = 1.32

export function widthEm(text: string): number {
  let total = 0
  for (const character of text) total += WIDE_CHARACTER.test(character) ? 1 : NARROW_EM
  return total
}
/** Lines `text` takes in a box `width` em wide, breaking between words and around East Asian characters. */
export function lineCount(text: string, width: number): number {
  let lines = 0
  for (const paragraph of text.split('\n')) {
    lines++
    let used = 0
    for (const token of paragraph.match(TOKENS) ?? []) {
      const ink = widthEm(token.trimEnd())
      if (used > 0 && used + ink > width) { lines++; used = 0 }
      if (ink > width) {
        // A word wider than the box breaks inside itself.
        const extra = Math.ceil(ink / width) - 1
        lines += extra
        used = ink - extra * width
      } else used += ink
      used += widthEm(token) - widthEm(token.trimEnd())
    }
  }
  return lines
}
/** One paragraph of a region: its text, the points a bullet indents it, and the points smaller a lower level is set. */
export interface Paragraph { readonly text: string; readonly indent?: number; readonly smaller?: number }
/** A region's room for text in points, inside its margins. */
export interface Room { readonly width: number; readonly height: number }
/** Points `paragraphs` take when set at `size`, with `gap` points after each but the last. */
export function textHeight(paragraphs: readonly Paragraph[], width: number, size: number, gap: number): number {
  return paragraphs.reduce((total, paragraph, index) => {
    const own = size - (paragraph.smaller ?? 0)
    return total + (index ? gap : 0) + lineCount(paragraph.text, (width - (paragraph.indent ?? 0)) / own) * own * LINE_EM
  }, 0)
}
/**
 * The largest size from `start` down to `min`, in 2-point steps, at which the text fits.
 * @param gap - points after each paragraph at a size.
 * @returns `fits` false, at `min`, when even that overflows.
 */
export function fitText(paragraphs: readonly Paragraph[], room: Room, start: number, min: number, gap: (size: number) => number = () => 0): { readonly size: number; readonly fits: boolean } {
  for (let size = start; size >= min; size -= 2) if (textHeight(paragraphs, room.width, size, gap(size)) <= room.height) return { size, fits: true }
  return { size: min, fits: false }
}
