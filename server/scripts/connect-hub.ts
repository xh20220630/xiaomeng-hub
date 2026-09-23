/** 开发与运维入口：将本机 Claude 桥接到远程中心。 */
import type { ProjectView, SessionView, ApprovalView, TaskEvent } from '../src/types/domain.js';
import { asError } from '../src/utils/errors.js';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { AgentClient } from '../src/sdk/agent-client.js';

const bridge = new URL(process.env.BRIDGE_URL || 'http://127.0.0.1:4820');
const hub = new URL(process.env.HUB_URL || 'http://localhost:4820');
if (bridge.origin === hub.origin)
  throw new Error('HUB_URL 必须指向中心服务，BRIDGE_URL 指向本机 Claude 桥接服务');
const bridgeToken = process.env.BRIDGE_TOKEN || '';
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bridgeToken}` };
const sessions = new Map<
  string,
  {
    /** 当前上报的项目摘要。 */
    project: ProjectView;
    /** 当前上报的会话摘要。 */
    session: SessionView;
  }
>();
const versions = new Map<string, string>();
const pendingApprovals = new Set<string>();
let bridgeAvailable = true;
const eventTypes: Record<string, string> = {
  UserPromptSubmit: 'message.user',
  AssistantText: 'message.assistant',
  Thinking: 'thinking',
  PreToolUse: 'tool.started',
  PostToolUse: 'tool.finished',
  PostToolUseFailure: 'tool.finished',
};

/**
 * 向独立本机桥接服务发起认证请求，避免误连中心形成回路。
 * @param endpoint 请求路径或本机 IPC 端点。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @returns 桥接服务返回的数据。
 */
async function local<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`${bridge.origin}/api${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
    redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Bridge HTTP ${response.status}`);
  return data as T;
}

const client = new AgentClient({
  hubUrl: hub.origin,
  enrollmentToken: process.env.HUB_TOKEN,
  nodeId: process.env.NODE_ID,
  agentKey: process.env.AGENT_KEY || 'claude-bridge',
  name: process.env.AGENT_NAME || 'Claude Code',
  provider: 'claude-code',
  stateFile: process.env.AGENT_STATE_FILE,
  /**
   * 确认实际执行通道可用后才允许领取命令，避免接单后无法执行。
   * @returns 当前是否可以处理中心命令。
   */
  isAvailable: () => bridgeAvailable,
  handlers: {
    /**
     * 按当前主机能力返回模型和操作目录，避免客户端硬编码选项。
     * @param payload 该能力对应的命令负载。
     * @param payload.sessionId 目标会话标识。
     * @returns 可用能力目录。
     */
    'agent.catalog': ({ sessionId }) =>
      local(
        `/agents/local-claude/catalog${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
      ),
    /**
     * 交给主机验证并保存下一轮设置，避免在客户端猜测配置是否生效。
     * @param payload 该能力对应的命令负载。
     * @param payload.sessionId 目标会话标识。
     * @param payload.settings 下一轮执行配置。
     * @param command 包含幂等标识和期限的中心命令。
     * @returns 已确认的执行设置或配置回执。
     */
    'session.configure': ({ sessionId, settings }, command) =>
      local(`/sessions/${encodeURIComponent(sessionId)}/configure`, {
        settings,
        requestId: command.commandId,
      }),
    /**
     * 转交续聊指令，使同一会话通过既有执行通道继续。
     * @param payload 该能力对应的命令负载。
     * @param payload.sessionId 目标会话标识。
     * @param payload.text 用户要执行的指令。
     * @returns 消息执行的异步回执。
     */
    'message.send': ({ sessionId, text }) =>
      local(`/sessions/${encodeURIComponent(sessionId)}/message`, { text }),
    /**
     * 停止指定会话的当前执行，避免影响其他会话。
     * @param payload 该能力对应的命令负载。
     * @param payload.sessionId 目标会话标识。
     * @returns 停止操作的回执。
     */
    'session.stop': ({ sessionId }) =>
      local(`/sessions/${encodeURIComponent(sessionId)}/control`, { action: 'stop' }),
    /**
     * 将手机决定交给审批所属主机，并等待明确确认。
     * @param payload 该能力对应的命令负载。
     * @param payload.approvalId 需要回复的审批标识。
     * @param payload.decision 用户选择的审批决定。
     * @param payload.scope 本次授权的有效范围。
     * @returns 主机确认结果。
     */
    'approval.respond': async ({ approvalId, decision, scope }) => {
      const result = await local<{
        /** 该实体当前的执行或处理状态。 */
        status: string;
      }>(`/approvals/${encodeURIComponent(approvalId)}`, { decision, scope });
      if (!['approved', 'denied'].includes(result.status))
        throw new Error('本机审批已过期或未生效');
      if (result.status !== (decision === 'approve' ? 'approved' : 'denied'))
        throw new Error('本机审批已被另一个决定处理');
      return result;
    },
  },
});

/**
 * 按版本同步桥接项目、历史与审批，避免重复上报未变化会话。
 * @returns 操作完成的异步信号。
 */
async function mirror() {
  const projects = await local<ProjectView[]>('/projects');
  bridgeAvailable = true;
  for (const project of projects.filter((p) => !p.agentId || p.agentId === 'local-claude')) {
    for (const session of project.sessions || []) {
      const signature = JSON.stringify([
        session.updated_at,
        session.status,
        session.summary,
        session.model,
        session.reasoningEffort,
        session.mode,
        project.status,
      ]);
      sessions.set(session.session_id, { project, session });
      if (versions.get(session.session_id) === signature) continue;
      await client.session(
        { id: project.projectId, name: project.name, cwd: project.cwd },
        {
          id: session.session_id,
          summary: session.summary || undefined,
          updatedAt: session.updated_at,
          status: project.activeSessionId === session.session_id ? project.status : session.status,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          mode: session.mode,
          controlTransport: 'claude-cli',
        },
      );
      const events = await local<TaskEvent[]>(
        `/sessions/${encodeURIComponent(session.session_id)}/events`,
      );
      for (const event of events.sort((a, b) => (a.id || 0) - (b.id || 0))) {
        const type = eventTypes[event.hook_event_name];
        if (!type) continue;
        const eventId = createHash('sha256')
          .update(
            JSON.stringify([
              event.hook_event_name,
              event.created_at,
              event.detail,
              event.tool_name,
              event.ok,
            ]),
          )
          .digest('hex');
        await client.event(session.session_id, type, {
          eventId,
          text: event.detail || '',
          toolName: event.tool_name,
          ok: event.ok,
        });
      }
      versions.set(session.session_id, signature);
    }
  }
  const approvals = await local<ApprovalView[]>('/approvals');
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
    await client.approval({
      ...approval,
      command: approval.command || undefined,
      filePath: approval.filePath || undefined,
      diff: approval.diff || undefined,
      risk: approval.risk || undefined,
      id: approval.approvalId,
      ttlMs,
    });
    pendingApprovals.add(approval.approvalId);
  }
}

await local('/projects');
await client.connect();
let stopped = false;
let socket: WebSocket | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
/**
 * 连接桥接端实时事件并在断线后恢复推送。
 * @returns 无返回值。
 */
function connectStream() {
  const url = new URL('/ws', bridge);
  url.protocol = bridge.protocol === 'https:' ? 'wss:' : 'ws:';
  if (bridgeToken) url.searchParams.set('token', bridgeToken);
  socket = new WebSocket(url);
  let pending = Promise.resolve();
  socket.on('message', (raw) => {
    pending = pending
      .then(async () => {
        const message = JSON.parse(raw.toString());
        if (!['assistant.start', 'assistant.delta', 'assistant.done'].includes(message.type))
          return;
        if (!sessions.has(message.sessionId)) return;
        await client.event(message.sessionId, message.type, {
          text: message.text,
          ok: message.ok,
          error: message.error,
          aborted: message.aborted,
        });
      })
      .catch((error) => console.error('[bridge stream]', error.message));
  });
  socket.on('error', (error) => console.error('[bridge socket]', error.message));
  socket.on('close', () => {
    if (!stopped) retry = setTimeout(connectStream, 2000);
  });
}
connectStream();
console.log('Claude 接入端已连接中心服务。支持监控、续聊、停止平台任务及单次审批。');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
    await client.close();
    process.exit(0);
  });
while (!stopped) {
  try {
    await mirror();
  } catch (cause) {
    const error = asError(cause);
    bridgeAvailable = false;
    console.error('[bridge sync]', error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
