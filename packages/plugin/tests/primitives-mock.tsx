/**
 * Stand-ins for the Harness primitives, which load only inside the Harness client.
 * Icons draw nothing; a menu lists its rows as buttons while open; an anchored panel sits at the origin.
 */
import { vi } from 'vitest'
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactElement, type ReactNode } from 'react'

interface Row { readonly id: string; readonly type?: string; readonly label?: ReactNode; readonly text?: string; readonly disabled?: boolean }
function Menu({ open, anchor, items = [], onSelect }: { open: boolean; anchor: ReactNode; items?: readonly Row[]; onSelect?: (id: string) => void }) {
  return <span>{anchor}{open && <span role="menu">{items.map(item => item.type === 'separator' ? null : item.type === 'label' ? <span key={item.id}>{item.text}</span>
    : <button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={() => { onSelect?.(item.id) }}>{item.label}</button>)}</span>}</span>
}
const base: Record<string, unknown> = {
  Button: ({ variant: _variant, size: _size, icon: _icon, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string; icon?: ReactNode }) => <button {...props} />,
  Modal: ({ children, open, title, footer }: { children?: ReactNode; open: boolean; title: string; footer?: ReactNode }) => open ? <section aria-label={title}>{children}{footer}</section> : null,
  Menu,
  MenuSurface: forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>((props, ref) => <div ref={ref} {...props} />),
  useAnchoredPosition: () => ({ left: 0, top: 0 }),
  useDismissOnOutsidePointer: () => {},
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TextShimmer: ({ children, active }: { children: ReactNode; active?: boolean }) => <span data-shimmer={active || undefined}>{children}</span>,
  MarkdownText: ({ text }: { text: string }) => <p>{text}</p>,
  ImageLightbox: () => null,
  FileTypeIcon: () => null,
  classifyFileType: (name: string) => /\.pdf$/iu.test(name) ? 'pdf' : /\.docx?$/iu.test(name) ? 'word' : /\.xlsx?$/iu.test(name) ? 'excel' : /\.(png|jpe?g|gif|webp)$/iu.test(name) ? 'image' : 'other',
  writeClipboard: vi.fn(async () => {}),
}
/** @returns the stand-in module: named pieces above, and an empty glyph for any icon. */
export function primitives(): Record<string, unknown> {
  return new Proxy(base, {
    get: (target, key) => typeof key === 'string' && !(key in target) && key.startsWith('Icon') ? () => null : target[key as string],
    has: (target, key) => key in target || (typeof key === 'string' && key.startsWith('Icon')),
  })
}
