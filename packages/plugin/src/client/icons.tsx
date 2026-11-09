/** Glyphs the Harness icon set lacks, drawn on the same 24px grid with currentColor strokes. */
interface GlyphProps { readonly size?: number }
const glyph = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true })

export function ArrowUpGlyph({ size = 20 }: GlyphProps) { return <svg {...glyph(size)}><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></svg> }
export function ArrowDownGlyph({ size = 20 }: GlyphProps) { return <svg {...glyph(size)}><path d="M12 5v14" /><path d="m6 13 6 6 6-6" /></svg> }
export function SpeakerGlyph({ size = 18 }: GlyphProps) { return <svg {...glyph(size)}><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg> }
export function StopGlyph({ size = 14 }: GlyphProps) { return <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden><rect x="1" y="1" width="12" height="12" rx="2.5" fill="currentColor" /></svg> }
/** Files of several kinds fanned out, for the drop invitation. */
export function DropGlyph() {
  return <svg width="96" height="64" viewBox="0 0 96 64" fill="none" aria-hidden>
    <rect x="6" y="14" width="34" height="42" rx="7" transform="rotate(-12 6 14)" fill="currentColor" opacity=".18" />
    <rect x="56" y="8" width="34" height="42" rx="7" transform="rotate(12 56 8)" fill="currentColor" opacity=".18" />
    <rect x="30" y="4" width="36" height="46" rx="8" fill="currentColor" opacity=".32" />
    <path d="M48 18v18M39 27h18" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
}
