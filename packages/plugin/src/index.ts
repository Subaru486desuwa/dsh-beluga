export { default, PersonalChatService } from './host/service.ts'
export { Config } from './host/config.ts'
export type * from './shared/types.ts'
export type * from './shared/models.ts'

export { PersonalChatError } from './host/archive.ts'
export { validateDocument, type DocumentCheck, type DocumentInput, type ParagraphChange } from './host/documents.ts'
export { reachesOutside, validateWorkbook, type CellChange, type WorkbookCell, type WorkbookCheck, type WorkbookInput } from './host/workbooks.ts'
export { officeFormat, type OfficeEngine } from './host/office-contract.ts'
