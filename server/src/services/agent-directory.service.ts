/** 统一组合本机和远程 Agent，HTTP 与 WebSocket 使用相同的在线视图。 */
import { listAgents } from './agent.service.js';
import { localAgent } from '../adapters/claude/local-agent.js';
import type { AgentView } from '../types/domain.js';

/**
 * 根据本机适配器开关返回当前 Agent 目录。
 * @returns 含本机和远程心跳状态的 Agent 列表。
 */
export function allAgents(): AgentView[] {
  return [...(process.env.LOCAL_CLAUDE === '0' ? [] : [localAgent()]), ...listAgents()];
}
