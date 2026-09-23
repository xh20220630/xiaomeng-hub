/** 向平台声明本机 Claude 身份和能力，统一展示本地与远程 Agent。 */
import type { ProjectView, AgentView } from '../../types/domain.js';
import os from 'node:os';
import { sessionSettings } from '../../services/settings.service.js';

/**
 * 声明本机 Claude 适配器实际支持的能力。
 * @returns 本机 Agent 目录项。
 */
export function localAgent(): AgentView {
  return {
    agentId: 'local-claude',
    agentKey: 'local-claude',
    provider: 'claude-code',
    name: 'Claude Code',
    nodeId: process.env.NODE_ID || os.hostname(),
    nodeName: os.hostname(),
    online: true,
    capabilities: [
      'message.send',
      'session.start',
      'session.stop',
      'approval.respond',
      'agent.catalog',
      'session.configure',
    ],
    protocolVersion: 1,
  };
}

/**
 * 为文件来源的项目补充主机身份和会话设置。
 * @param project 会话所属项目或项目摘要。
 * @returns 可与远程项目统一展示的项目视图。
 */
export function withLocalAgent(project: ProjectView) {
  const agent = localAgent();
  return {
    ...project,
    agentId: agent.agentId,
    agentName: agent.name,
    provider: agent.provider,
    nodeId: agent.nodeId,
    nodeName: agent.nodeName,
    online: true,
    capabilities: agent.capabilities,
    sessions: project.sessions?.map((session) => ({
      ...session,
      ...sessionSettings(session.session_id),
      controlTransport: 'claude-cli',
    })),
  };
}
