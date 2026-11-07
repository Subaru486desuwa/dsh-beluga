import type { AttachmentText } from '../shared/types.ts'
import type { DocumentInput } from './documents.ts'
export interface OfficeEngine {
  extractText(bytes: Uint8Array, name: string, limit: number, signal: AbortSignal): AttachmentText
  renderDocument(input: DocumentInput, signal: AbortSignal): Promise<Uint8Array>
}
declare module '@deepseek-ai/cordis' { interface Context { personalChatOffice: OfficeEngine } }
export const officeMediaTypes: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
export function officeFormat(name: string): string | undefined {
  const extension = name.split('.').at(-1)?.toLowerCase()
  return extension && Object.hasOwn(officeMediaTypes, extension) ? extension : undefined
}
