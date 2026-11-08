/** Which members of an official export ZIP hold conversations. Client and Host apply the same rules. */
type Fail = (message: string) => never

const CONVERSATION_MEMBER = /^conversations(?:-(\d+))?\.json$/u
const SINGLE_MEMBER = 'conversations.json'

export function isZipName(fileName: string): boolean { return /\.zip$/iu.test(fileName) }
export function isConversationMember(name: string): boolean { return CONVERSATION_MEMBER.test(name) }

/**
 * Reduce an entry path to its base name. Nothing is extracted, so paths never reach a
 * file system, but a traversal path marks an archive no official export would produce.
 * @param path - entry name as stored in the ZIP.
 * @param fail - raises the caller's error type.
 * @returns the base name.
 */
export function zipMemberName(path: string, fail: Fail): string {
  const parts = path.replaceAll('\\', '/').split('/')
  if (parts.includes('..') || path.startsWith('/') || /^[a-z]:/iu.test(path)) fail(`Unsafe ZIP entry: ${path}`)
  return parts.at(-1)!
}

/**
 * Put members in shard order, refusing any set that could silently lose conversations.
 * @param members - conversation members in ZIP order.
 * @param fail - raises the caller's error type.
 * @returns the members in reading order.
 */
export function orderConversationMembers<T extends { readonly name: string }>(members: readonly T[], fail: Fail): T[] {
  if (!members.length) fail('ZIP requires conversations.json or conversations-NNN.json')
  const singles = members.filter(member => member.name === SINGLE_MEMBER).length
  if (singles > 1) fail('ZIP contains multiple conversations.json files')
  if (singles && members.length > 1) fail('ZIP contains both conversations.json and numbered shards')
  if (singles) return [...members]
  const shard = (member: T) => Number(CONVERSATION_MEMBER.exec(member.name)![1])
  const ordered = [...members].sort((a, b) => shard(a) - shard(b))
  ordered.forEach((member, index) => {
    const expected = `conversations-${String(index).padStart(3, '0')}.json`
    if (shard(member) < index) fail(`ZIP contains multiple ${member.name} files`)
    if (shard(member) > index) fail(`ZIP is missing ${expected}`)
  })
  return ordered
}
