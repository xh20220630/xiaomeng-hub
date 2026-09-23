/** 把 Codex 历史条目转为平台事件，保留工具输出及稳定去重标识。 */
import type { CodexItem, CodexContent } from '../../types/codex.js';
import type { TaskEvent } from '../../types/domain.js';
import { createHash } from 'node:crypto';

/**
 * 使用线程与活动标识生成跨同步稳定的事件键。
 * @param threadId Codex 主机线程标识。
 * @param key 用于队列、映射或去重的稳定键。
 * @returns SHA-256 事件标识。
 */
export const codexEventKey = (threadId: string, key: string) =>
  createHash('sha256').update(`${threadId}\0${key}`).digest('hex');

/**
 * 提取可显示工具文本，避免把图像或音频二进制复制到历史中。
 * @param result 当前主机或存储操作的结果。
 * @returns 适合客户端显示的工具结果文本。
 */
export function toolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  const content =
    result && typeof result === 'object' && 'content' in result ? result.content : undefined;
  if (Array.isArray(content))
    return (content as CodexContent[])
      .map((block) => {
        if (block.type === 'text') return block.text || '';
        if (block.type === 'image') return '[图片结果]';
        if (block.type === 'audio') return '[音频结果]';
        if (block.type === 'resource_link') return block.title || block.name || block.uri;
        if (block.type === 'resource') return block.resource?.text || '[附件结果]';
        return `[${block.type || '附件'}]`;
      })
      .join('\n\n');
  return JSON.stringify(result ?? {}, null, 2);
}

/**
 * 把主机历史活动转换为统一事件，并保留轮次和工具关联。
 * @param threadId Codex 主机线程标识。
 * @param turnId 主机执行轮次标识。
 * @param item 当前轮次内的消息或工具活动。
 * @param createdAt 事件或命令发生的时间戳。
 * @returns 受支持的事件；未知活动返回 null。
 */
export function historyEvent(
  threadId: string,
  turnId: string,
  item: CodexItem,
  createdAt: number | null = null,
): TaskEvent | null {
  const event = {
    event_key: codexEventKey(threadId, `${turnId}:${item.id}:completed`),
    created_at: createdAt,
    status: 'done',
    turn_id: turnId,
    item_id: item.id,
    tool_call_id: `${turnId}:${item.id}`,
  };
  if (item.type === 'userMessage')
    return {
      ...event,
      hook_event_name: 'UserPromptSubmit',
      detail: (item.content || []).map((c) => c.text || `[${c.type}]`).join('\n'),
    };
  if (item.type === 'agentMessage')
    return {
      ...event,
      hook_event_name: 'AssistantText',
      phase: item.phase,
      detail: item.text || '',
    };
  if (item.type === 'reasoning' && item.summary?.length)
    return { ...event, hook_event_name: 'Thinking', detail: item.summary.join('\n') };
  const names: Record<string, string> = {
    commandExecution: 'Terminal',
    fileChange: 'FileChange',
    plan: 'Plan',
    webSearch: 'WebSearch',
    exitedReviewMode: 'Review',
  };
  if (names[item.type] || ['mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
    const detail =
      item.type === 'commandExecution'
        ? `${item.command}\n${item.aggregatedOutput || ''}`
        : item.type === 'fileChange'
          ? (item.changes || []).map((c) => `${c.path}\n${c.diff}`).join('\n\n')
          : item.text || item.review || toolResult(item.result || item.arguments || item.action);
    return {
      ...event,
      hook_event_name: item.status === 'inProgress' ? 'PreToolUse' : 'PostToolUse',
      tool_name: names[item.type] || `${item.server || ''}/${item.tool || item.type}`,
      detail,
      tool_input:
        item.type === 'commandExecution'
          ? item.command
          : item.arguments == null
            ? null
            : toolResult(item.arguments),
      ok: !['failed', 'declined'].includes(item.status || '') && item.success !== false,
    };
  }
  return null;
}
