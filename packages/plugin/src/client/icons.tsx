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
/** The GitHub mark, filled, for the GitHub app wherever it is offered. */
export function GitHubGlyph({ size = 18 }: GlyphProps) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>
}
