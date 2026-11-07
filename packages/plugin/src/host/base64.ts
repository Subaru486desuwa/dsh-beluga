/**
 * Strictly decode bounded base64 in linear time. A round trip accepts only canonical
 * text; a validating regular expression overflows the stack on multi-megabyte input.
 * @param value - base64 text from a Remote request.
 * @param maxBytes - largest decoded size accepted.
 * @returns the decoded bytes, or undefined when invalid or too large.
 */
export function decodeBase64(value: string, maxBytes: number): Buffer | undefined {
  if (value.length > Math.ceil(maxBytes / 3) * 4) return undefined
  const bytes = Buffer.from(value, 'base64')
  return bytes.length <= maxBytes && bytes.toString('base64') === value ? bytes : undefined
}
