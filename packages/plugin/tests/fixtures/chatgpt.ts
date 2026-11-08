export const fixture = [{ id: 'source-1', title: 'Branches', current_node: 'b', unknown: { keep: true }, mapping: {
  root: { id: 'root', parent: null, children: ['a', 'b'], message: null },
  a: { id: 'a', parent: 'root', children: [], message: { author: { role: 'assistant' }, create_time: 30, content: { content_type: 'text', parts: ['OTHER_BRANCH'] } } },
  b: { id: 'b', parent: 'root', children: [], message: { author: { role: 'user' }, create_time: 10, content: { content_type: 'text', parts: ['SELECTED_BRANCH'] } } },
} }]

/** Shape of the official export seen in November 2026: edges live only on `parent`, and reasoning is stored as nodes of its own. */
export const currentExport = [{ id: 'source-2', title: 'Current export', current_node: 'answer', unknown: { keep: true }, mapping: {
  root: { id: 'root', parent: null, message: null },
  question: { id: 'question', parent: 'root', message: { author: { role: 'user' }, create_time: 1, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer' }, 'LOOK_AT_THIS'] } } },
  thought: { id: 'thought', parent: 'question', message: { author: { role: 'assistant' }, create_time: 2, content: { content_type: 'thoughts', thoughts: [{ summary: 'PRIVATE_REASONING' }] } } },
  recap: { id: 'recap', parent: 'thought', message: { author: { role: 'assistant' }, create_time: 3, content: { content_type: 'reasoning_recap', content: 'Thought for 3s' } } },
  answer: { id: 'answer', parent: 'recap', message: { author: { role: 'assistant' }, create_time: 4, content: { content_type: 'text', parts: ['FINAL_ANSWER'] } } },
  retry: { id: 'retry', parent: 'question', message: { author: { role: 'assistant' }, create_time: 5, content: { content_type: 'text', parts: ['RETRIED_ANSWER'] } } },
} }]
