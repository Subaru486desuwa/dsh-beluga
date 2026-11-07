import { Context, Service } from '@deepseek-ai/cordis'
import type { OfficeEngine } from 'dsh-beluga'
import { extractOfficeText } from './office.ts'
import { renderDocument } from './documents.ts'
export default class PersonalChatOffice extends Service implements OfficeEngine {
  static inject = ['personalChat']
  constructor(ctx: Context) { super(ctx, 'personalChatOffice') }
  extractText = extractOfficeText
  renderDocument = renderDocument
}
