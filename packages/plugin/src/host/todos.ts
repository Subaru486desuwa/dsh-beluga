/**
 * The to-do list a model keeps while it works through a turn. It mirrors the Harness Work
 * `todo_write` tool, but lives in the turn's own tool calls: the list a person sees is the
 * last valid call, so a stored chat needs no other record of it.
 */
import { z } from 'zod'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { TodoItem } from '../shared/types.ts'

export const TODO_TOOL = 'todo_write'
const MAX_TODOS = 20
const MAX_TODO_CHARS = 200

const todoList = z.object({
  todos: z.array(z.object({ content: z.string().trim().min(1).max(MAX_TODO_CHARS), status: z.enum(['pending', 'in_progress', 'completed']) }).strict()).max(MAX_TODOS),
}).strict().superRefine(({ todos }, context) => {
  if (new Set(todos.map(todo => todo.content)).size !== todos.length) context.addIssue({ code: 'custom', message: 'Each todo needs distinct content' })
  if (todos.filter(todo => todo.status === 'in_progress').length > 1) context.addIssue({ code: 'custom', message: 'Keep at most one todo in_progress' })
})

export const todoSchema: ToolSchema = {
  name: TODO_TOOL,
  description: 'Record and update a task list to plan multi-step work and show the person your progress; skip it for questions and other single-step tasks. Add one todo per concrete step before you start. While work remains, keep exactly one todo `in_progress`. Mark each todo `completed` as soon as it is done. Write todos in the language of the conversation.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array', maxItems: MAX_TODOS, description: 'The COMPLETE task list, replacing any previous list.',
        items: { type: 'object', properties: { content: { type: 'string', description: 'What the task is, as a short imperative line.' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'pending (not started) | in_progress (now) | completed (done).' } }, required: ['content', 'status'], additionalProperties: false },
      },
    },
    required: ['todos'], additionalProperties: false,
  },
}

/** @throws z.ZodError naming what the model must correct. */
export function parseTodos(raw: unknown): readonly TodoItem[] { return todoList.parse(raw).todos }

/** The last valid list a message wrote; an invalid call was refused and never shown. */
export function todosOf(message: Message): readonly TodoItem[] | undefined {
  let todos: readonly TodoItem[] | undefined
  for (const block of message.content) {
    if (block.type !== 'tool-call' || block.name !== TODO_TOOL) continue
    try { todos = parseTodos(JSON.parse(block.arguments)) } catch { /* Refused calls never reached the list. */ }
  }
  return todos
}
