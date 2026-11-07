export const fixture = [{ id: 'source-1', title: 'Branches', current_node: 'b', unknown: { keep: true }, mapping: {
  root: { id: 'root', parent: null, children: ['a', 'b'], message: null },
  a: { id: 'a', parent: 'root', children: [], message: { author: { role: 'assistant' }, create_time: 30, content: { content_type: 'text', parts: ['OTHER_BRANCH'] } } },
  b: { id: 'b', parent: 'root', children: [], message: { author: { role: 'user' }, create_time: 10, content: { content_type: 'text', parts: ['SELECTED_BRANCH'] } } },
} }]
