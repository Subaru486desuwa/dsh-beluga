import { createHash } from 'node:crypto'
/** Conservative admission policy: only source-grounded, low-risk facts autosave. */
import type { ConversationId, MemoryCandidate, MemorySource } from '../shared/types.ts'
import type { MemoryLedger } from './records.ts'
import { canonical } from './archive.ts'

export function fingerprint(text: string): string { return createHash('sha256').update(normalized(text)).digest('hex') }
export function evidenceKey(source: MemorySource): string { return createHash('sha256').update(canonical({ ...source })).digest('hex') }
export function normalized(text: string): string { return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() }
/** @param candidates - the ledger's candidates. @returns the chats whose memory proposals wait for the person. */
export function proposingChats(candidates: readonly MemoryCandidate[]): Set<ConversationId> {
  const chats = new Set<ConversationId>()
  for (const candidate of candidates) if (candidate.state === 'pending' && candidate.source.kind === 'chat') chats.add(candidate.source.conversationId)
  return chats
}
const sensitive = /(?:password|passcode|secret|token|api[ _-]?key|credential|social security|ssn|passport|credit card|bank|account number|HIV|cancer|diabetes|autism|diagnos|disease|medicat|mental health|sexual|religio|politic|race|ethnic|salary|income|address|phone|email|身份证|护照|密码|密钥|令牌|银行卡|账户|住址|地址|电话|邮箱|诊断|疾病|病史|服药|药物|抑郁|焦虑|性取向|性生活|宗教|政治|民族|种族|工资|收入|财务|怀孕|残疾|健康)/iu
const lowRisk = /^(?:(?:I\s+)?(?:prefer|like|dislike|use|am learning|study|research)\s+(?:(?:concise|detailed|short|long|bulleted|markdown|simplified chinese|english)(?:\s+(?:answers|responses|replies|format|lists))?|python|javascript|typescript|linux|macos|windows|vscode|vim|emacs|coffee|tea|pizza|vegetarian food|computer vision|deep learning|machine learning)|(?:我)?(?:喜欢|偏好|使用|正在学习|研究)(?:简洁(?:的)?(?:回复|回答)|详细(?:的)?(?:回复|回答)|要点列表|简体中文|英文|Python|JavaScript|Linux|咖啡|茶|披萨|素食|计算机视觉|深度学习|机器学习)|请用(?:简体中文|英文)(?:回复|回答))[。.！!]?$/iu
const explicit = /(?:remember|save (?:this|that)|记住|记下来|存入记忆|保存.{0,8}记忆)/iu
/** Never consume a model-provided sensitivity or authorization boolean. */
export function candidateReason(text: string, evidence: string, source: MemorySource, ledger: MemoryLedger, replaces?: string): MemoryCandidate['reason'] {
  if (sensitive.test(text) || sensitive.test(evidence) || /\b\d{6,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(text)) return 'sensitive'
  if (ledger.suppressed.some(item => ((source.kind === 'chat' || source.kind === 'archive') && item.evidence === evidenceKey(source)) || fingerprint(text) === item.text)) return 'suppressed'
  const terms = normalized(text).match(/[\p{L}\p{N}]{3,}/gu) ?? []
  const overlaps = ledger.memories.some(memory => memory.state === 'active' && normalized(memory.text) !== normalized(text) && terms.some(term => !['the', 'and', 'prefer', 'like', 'remember'].includes(term) && normalized(memory.text).includes(term)))
  if (replaces || overlaps) return 'conflict'
  if (source.kind === 'archive') return 'archive'
  if (source.kind !== 'chat') return 'review'
  if (!normalized(evidence).includes(normalized(text))) return 'inference'
  if (/假设|假如|如果|例如|比如|他说|她说|引用|suppose|hypothetic|for example/iu.test(evidence)) return 'inference'
  if (!lowRisk.test(text) || text.length > 240) return 'review'
  return explicit.test(evidence) ? 'explicit' : 'low-risk'
}
