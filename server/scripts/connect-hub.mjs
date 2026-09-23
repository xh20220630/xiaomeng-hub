import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { AgentClient } from '../sdk/agent-client.mjs';

const bridge = new URL(process.env.BRIDGE_URL || 'http://127.0.0.1:4820');
const hub = new URL(process.env.HUB_URL || 'http://localhost:4820');
if (bridge.origin === hub.origin) throw new Error('HUB_URL 必须指向中心服务，BRIDGE_URL 指向本机 Claude 桥接服务');
const bridgeToken = process.env.BRIDGE_TOKEN || '';
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bridgeToken}` };
const sessions = new Map();
const versions = new Map();
const pendingApprovals = new Set();
let bridgeAvailable = true;
const eventTypes = {
  UserPromptSubmit: 'message.user', AssistantText: 'message.assistant', Thinking: 'thinking',
  PreToolUse: 'tool.started', PostToolUse: 'tool.finished', PostToolUseFailure: 'tool.finished',
};

async function local(endpoint, body) {
  const response = await fetch(`${bridge.origin}/api${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35000), redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Bridge HTTP ${response.status}`);
  return data;
}

const client = new AgentClient({
  hubUrl: hub.origin, enrollmentToken: process.env.HUB_TOKEN, nodeId: process.env.NODE_ID,
  agentKey: process.env.AGENT_KEY || 'claude-bridge', name: process.env.AGENT_NAME || 'Claude Code', provider: 'claude-code',
  stateFile: process.env.AGENT_STATE_FILE,
  isAvailable: () => bridgeAvailable,
  handlers: {
    'agent.catalog': ({ sessionId }) => local(`/agents/local-claude/catalog${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
    'session.configure': ({ sessionId, settings }, command) => local(`/sessions/${encodeURIComponent(sessionId)}/configure`, { settings, requestId: command.commandId }),
    'message.send': ({ sessionId, text }) => local(`/sessions/${encodeURIComponent(sessionId)}/message`, { text }),
    'session.stop': ({ sessionId }) => local(`/sessions/${encodeURIComponent(sessionId)}/control`, { action: 'stop' }),
    'approval.respond': async ({ approvalId, decision, scope }) => {
      const result = await local(`/approvals/${encodeURIComponent(approvalId)}`, { decision, scope });
      if (!['approved', 'denied'].includes(result.status)) throw new Error('本机审批已过期或未生效');
      if (result.status !== (decision === 'approve' ? 'approved' : 'denied')) throw new Error('本机审批已被另一个决定处理');
      return result;
    },
  },
});

async function mirror() {
  const projects = await local('/projects');
  bridgeAvailable = true;
  for (const project of projects.filter((p) => !p.agentId || p.agentId === 'local-claude')) {
    for (const session of project.sessions || []) {
      const signature = JSON.stringify([session.updated_at, session.status, session.summary, session.model, session.reasoningEffort, session.mode, project.status]);
      sessions.set(session.session_id, { project, session });
      if (versions.get(session.session_id) === signature) continue;
      await client.session({ id: project.projectId, name: project.name, cwd: project.cwd }, {
        id: session.session_id, summary: session.summary, updatedAt: session.updated_at,
        status: project.activeSessionId === session.session_id ? project.status : session.status,
        model: session.model, reasoningEffort: session.reasoningEffort, mode: session.mode, controlTransport: 'claude-cli',
      });
      const events = await local(`/sessions/${encodeURIComponent(session.session_id)}/events`);
      for (const event of events.sort((a, b) => a.id - b.id)) {
        const type = eventTypes[event.hook_event_name];
        if (!type) continue;
        const eventId = createHash('sha256').update(JSON.stringify([
          event.hook_event_name, event.created_at, event.detail, event.tool_name, event.ok,
        ])).digest('hex');
        await client.event(session.session_id, type, { eventId, text: event.detail || '', toolName: event.tool_name, ok: event.ok });
      }
      versions.set(session.session_id, signature);
    }
  }
  const approvals = await local('/approvals');
  const currentApprovals = new Set(approvals.map((a) => a.approvalId));
  for (const id of pendingApprovals) {
    if (!currentApprovals.has(id)) {
      await client.resolveApproval(id);
      pendingApprovals.delete(id);
    }
  }
  for (const approval of approvals) {
    if (!sessions.has(approval.sessionId)) continue;
    const ttlMs = Math.min(1800000, (approval.expiresAt || Date.now() + 1800000) - Date.now());
    if (ttlMs < 1000) continue;
    await client.approval({ ...approval, id: approval.approvalId, ttlMs });
    pendingApprovals.add(approval.approvalId);
  }
}

await local('/projects');
await client.connect();
let stopped = false;
let socket;
let retry;
function connectStream() {
  const url = new URL('/ws', bridge);
  url.protocol = bridge.protocol === 'https:' ? 'wss:' : 'ws:';
  if (bridgeToken) url.searchParams.set('token', bridgeToken);
  socket = new WebSocket(url);
  let pending = Promise.resolve();
  socket.on('message', (raw) => {
    pending = pending.then(async () => {
      const message = JSON.parse(raw.toString());
      if (!['assistant.start', 'assistant.delta', 'assistant.done'].includes(message.type)) return;
      if (!sessions.has(message.sessionId)) return;
      await client.event(message.sessionId, message.type, { text: message.text, ok: message.ok, error: message.error, aborted: message.aborted });
    }).catch((error) => console.error('[bridge stream]', error.message));
  });
  socket.on('error', (error) => console.error('[bridge socket]', error.message));
  socket.on('close', () => { if (!stopped) retry = setTimeout(connectStream, 2000); });
}
connectStream();
console.log('Claude 接入端已连接中心服务。支持监控、续聊、停止平台任务及单次审批。');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  stopped = true;
  clearTimeout(retry);
  socket?.close();
  await client.close();
  process.exit(0);
});
while (!stopped) {
  try { await mirror(); } catch (error) { bridgeAvailable = false; console.error('[bridge sync]', error.message); }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
