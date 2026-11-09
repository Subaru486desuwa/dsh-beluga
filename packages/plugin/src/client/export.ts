import type { ConversationDetail, WebSource } from '../shared/types.ts'

export interface ExportLabels { readonly user: string; readonly assistant: string }

/** Link text comes from web pages, so it must not be able to break out of the list item. */
function sourceLine({ url, title }: WebSource): string {
  const text = (title || url).replace(/\s+/gu, ' ').replace(/[\\[\]]/gu, '\\$&')
  return `- [${text}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})`
}

/**
 * Write a chat as the page shows it: imported history first, then the selected branch.
 * Tool output and reasoning stay out; they are working material, not conversation.
 * @param detail - the open chat.
 * @param labels - headings for each speaker, in the page language.
 * @returns the Markdown file content.
 */
export function conversationMarkdown(detail: ConversationDetail, labels: ExportLabels): string {
  const heading = (role: string | null) => role === 'user' ? labels.user : role === 'assistant' ? labels.assistant : undefined
  const blocks = detail.conversation.title ? [`# ${detail.conversation.title}`] : []
  const add = (role: string | null, ...parts: readonly string[]) => {
    const label = heading(role)
    if (label) blocks.push(`## ${label}`, ...parts.filter(Boolean))
  }
  for (const node of detail.archive?.branchNodes ?? []) if (!node.structural && !node.reasoning) add(node.role, node.text)
  for (const message of detail.messages) {
    const files = message.attachmentIds.flatMap(id => detail.attachments.find(file => file.id === id)?.name ?? [])
    add(message.role, message.text, ...files, (message.sources ?? []).map(sourceLine).join('\n'))
  }
  return blocks.join('\n\n') + '\n'
}

/** @returns a file name every desktop system accepts, whatever the chat is called. */
export function exportName(title: string): string {
  return (title.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').trim().slice(0, 120) || 'chat') + '.md'
}

export function decodeBase64(base64: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(base64), char => char.charCodeAt(0)) }
/** Hand the browser a file to save. */
export function saveFile(name: string, data: Blob): void {
  const url = URL.createObjectURL(data)
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
