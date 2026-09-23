import { createHash } from 'node:crypto';

export const codexEventKey = (threadId, key) => createHash('sha256').update(`${threadId}\0${key}`).digest('hex');

export function toolResult(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result?.content)) return result.content.map((block) => {
    if (block.type === 'text') return block.text || '';
    if (block.type === 'image') return '[图片结果]';
    if (block.type === 'audio') return '[音频结果]';
    if (block.type === 'resource_link') return block.title || block.name || block.uri;
    if (block.type === 'resource') return block.resource?.text || '[附件结果]';
    return `[${block.type || '附件'}]`;
  }).join('\n\n');
  return JSON.stringify(result ?? {}, null, 2);
}

export function historyEvent(threadId, turnId, item, createdAt) {
  const event = { event_key: codexEventKey(threadId, `${turnId}:${item.id}:completed`),
    created_at: createdAt, status: 'done', turn_id: turnId, item_id: item.id, tool_call_id: `${turnId}:${item.id}` };
  if (item.type === 'userMessage') return { ...event, hook_event_name: 'UserPromptSubmit',
    detail: (item.content || []).map((c) => c.text || `[${c.type}]`).join('\n') };
  if (item.type === 'agentMessage') return { ...event, hook_event_name: 'AssistantText', phase: item.phase, detail: item.text || '' };
  if (item.type === 'reasoning' && item.summary?.length) return { ...event, hook_event_name: 'Thinking', detail: item.summary.join('\n') };
  const names = { commandExecution: 'Terminal', fileChange: 'FileChange', plan: 'Plan', webSearch: 'WebSearch', exitedReviewMode: 'Review' };
  if (names[item.type] || ['mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
    const detail = item.type === 'commandExecution' ? `${item.command}\n${item.aggregatedOutput || ''}`
      : item.type === 'fileChange' ? (item.changes || []).map((c) => `${c.path}\n${c.diff}`).join('\n\n')
      : item.text || item.review || toolResult(item.result || item.arguments || item.action);
    return { ...event, hook_event_name: item.status === 'inProgress' ? 'PreToolUse' : 'PostToolUse',
      tool_name: names[item.type] || `${item.server || ''}/${item.tool || item.type}`, detail,
      tool_input: item.type === 'commandExecution' ? item.command : item.arguments == null ? null : toolResult(item.arguments),
      ok: !['failed', 'declined'].includes(item.status) && item.success !== false };
  }
  return null;
}
