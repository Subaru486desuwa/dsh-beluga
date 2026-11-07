import { describe, expect, it } from 'vitest'
import { withoutRemoteImages } from '../src/client/markdown.ts'

describe('Markdown media policy', () => {
  it('turns inline and reference images into explicit links without rewriting the rest', () => {
    const text = '# Title\n\n![private](https://example.invalid/x?q=secret)\n\n![ref][id]\n\n[id]: https://example.invalid/y\n\n`![literal](https://example.invalid)`'
    const result = withoutRemoteImages(text, 'External image')
    expect(result).not.toContain('![private]')
    expect(result).not.toContain('![ref]')
    expect(result).toContain('[private · External image]')
    expect(result).toContain('`![literal](https://example.invalid)`')
    expect(result.startsWith('# Title')).toBe(true)
  })
  it('preserves math and leaves unsafe or local destinations inert', () => {
    expect(withoutRemoteImages('$![math](x)$', 'Image')).toBe('$![math](x)$')
    const result = withoutRemoteImages('![local](/etc/passwd) ![data](data:image/png;base64,abc)', 'Image')
    expect(result).toBe('local data')
  })
})

it('blocks images inside incomplete math while streaming uses the GFM grammar', () => {
  const input = '$![secret](https://example.invalid/pixel)$'
  expect(withoutRemoteImages(input, 'image', true)).not.toContain('![')
  expect(withoutRemoteImages(input, 'image')).toBe(input)
})
