import os from 'node:os';
import { sessionSettings } from './agent-settings.js';

export function localAgent() {
  return {
    agentId: 'local-claude', provider: 'claude-code', name: 'Claude Code',
    nodeId: process.env.NODE_ID || os.hostname(), nodeName: os.hostname(),
    online: true, capabilities: ['message.send', 'session.start', 'session.stop', 'approval.respond', 'agent.catalog', 'session.configure'],
    protocolVersion: 1,
  };
}

export function withLocalAgent(project) {
  const agent = localAgent();
  return { ...project, agentId: agent.agentId, agentName: agent.name, provider: agent.provider,
    nodeId: agent.nodeId, nodeName: agent.nodeName, online: true, capabilities: agent.capabilities,
    sessions: project.sessions?.map((session) => ({ ...session, ...sessionSettings(session.session_id), controlTransport: 'claude-cli' })) };
}
