/** 业务服务协调Agent 注册、隔离与命令分发，通过仓储和适配器访问外部状态。 */
import type { AgentRow, RemoteSessionRow, CommandRow, JsonRow } from '../types/storage.js';
import type {
  AgentProfile,
  AgentView,
  SessionView,
  ProjectView,
  ApprovalView,
  SessionInput,
  RemoteProjectInput,
  TaskEvent,
  HistoryPage,
  EventInput,
  ApprovalInput,
  CommandView,
  CommandPayload,
  QueueOptions,
  SessionSettings,
  AgentCommand,
  CommandReceipt,
} from '../types/domain.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as repository from '../repositories/agent.repository.js';
import { broadcast } from '../events/hub-events.js';
import { localAgent } from '../adapters/claude/local-agent.js';
import { agentNotifications } from '../events/agent-events.js';

export const CAPABILITIES = [
  'message.send',
  'message.steer',
  'session.start',
  'session.stop',
  'approval.respond',
  'history.read',
  'agent.catalog',
  'session.configure',
  'session.compact',
  'agent.action',
];
const STATUSES = [
  'running',
  'waiting_input',
  'needs_approval',
  'done',
  'ended',
  'error',
  'paused',
  'rejected',
];
const HEARTBEAT_MS = Number(process.env.AGENT_OFFLINE_MS || 45000);
const COMMAND_MS = Number(process.env.AGENT_COMMAND_TIMEOUT_MS || 60000);

/**
 * 抛出带 HTTP 状态的业务错误，交给统一错误中间件处理。
 * @param status 本次保存或验证的状态。
 * @param message 协议消息或可展示的错误说明。
 * @returns 不返回；校验失败会抛出包含状态码的错误。
 */
export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/**
 * 在业务边界限制必填文本的类型、空白和长度。
 * @param value 需要校验、散列或转换的输入值。
 * @param name 字段、能力或实体的展示名称。
 * @param max 允许的文本长度上限。
 * @returns 校验通过的原始文本。
 */
export function string(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(400, `Invalid ${name}`);
  return value;
}

/**
 * 将缺省文本归一为空字符串，其余值沿用必填文本校验。
 * @param value 需要校验、散列或转换的输入值。
 * @param name 字段、能力或实体的展示名称。
 * @param max 允许的文本长度上限。
 * @returns 已校验的可选文本。
 */
function optional(value: unknown, name: string, max = 64000): string {
  return value == null || value === '' ? '' : string(value, name, max);
}

/**
 * 只接受客户端理解的任务状态，避免传播未知状态值。
 * @param value 需要校验、散列或转换的输入值。
 * @returns 校验通过的状态。
 */
function status(value: string): string {
  if (!STATUSES.includes(value)) fail(400, 'Invalid task status');
  return value;
}

/**
 * 使用不可逆摘要保存或关联敏感标识。
 * @param value 需要校验、散列或转换的输入值。
 * @returns SHA-256 十六进制摘要。
 */
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
/**
 * 把 Agent 范围内的远程 ID 映射为全局 ID，避免不同主机碰撞。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param kind 用于区分实体或审批种类的标签。
 * @param remoteId Agent 自己使用的远程实体标识。
 * @returns 带实体类别前缀的中心 ID。
 */
const entityId = (agentId: string, kind: string, remoteId: string): string =>
  `lan_${kind}_${hash(`${agentId}\0${remoteId}`).slice(0, 40)}`;
/**
 * 在已知表结构的边界解码 JSON 列，保留缺失行语义。
 * @param row 由仓储返回的持久化记录。
 * @returns 领域对象；未找到行时为 null。
 */
function parsed<T>(row: JsonRow<T>): T;
/**
 * 在已知表结构的边界解码 JSON 列，保留缺失行语义。
 * @param row 由仓储返回的持久化记录。
 * @returns 领域对象；未找到行时为 null。
 */
function parsed<T>(row: JsonRow<T> | undefined | null): T | null;
/**
 * 在已知表结构的边界解码 JSON 列，保留缺失行语义。
 * @param row 由仓储返回的持久化记录。
 * @returns 领域对象；未找到行时为 null。
 */
function parsed<T>(row: JsonRow<T> | undefined | null): T | null {
  return row ? (JSON.parse(row.data) as T) : null;
}
/**
 * 读取已认证或已关联的持久 Agent 身份。
 * @param id 待处理实体的稳定标识。
 * @returns 对应的 Agent 存储行。
 */
const getAgent = (id: string) => repository.findAgent(id)!;
/**
 * 根据最近心跳和离线阈值判断主机可用性。
 * @param row 由仓储返回的持久化记录。
 * @returns Agent 是否在线。
 */
const online = (row: AgentRow): boolean => Date.now() - row.last_seen < HEARTBEAT_MS;
/**
 * 读取远程会话归属，供统一操作服务选择执行通道。
 * @param id 待处理实体的稳定标识。
 * @returns 远程会话行或 undefined。
 */
export const remoteSession = (id: string) => repository.findSession(id);
/**
 * 读取远程项目归属，避免把远端项目当成本机路径。
 * @param id 待处理实体的稳定标识。
 * @returns 远程项目行或 undefined。
 */
export const remoteProject = (id: string) => repository.findProject(id);
/**
 * 读取远程审批归属，以便向正确 Agent 投递回复。
 * @param id 待处理实体的稳定标识。
 * @returns 远程审批行或 undefined。
 */
export const remoteApproval = (id: string) => repository.findApproval(id);

/**
 * 将身份资料与实时在线状态组合为客户端视图。
 * @param row 由仓储返回的持久化记录。
 * @returns Agent 展示对象。
 */
function agentJson(row: AgentRow): AgentView {
  return { ...parsed(row), agentId: row.id, online: online(row), lastSeenAt: row.last_seen };
}

/**
 * 读取按最近活动排序的 Agent 状态。
 * @returns Agent 身份与在线信息列表。
 */
export function listAgents() {
  return repository.listAgents().map(agentJson);
}

/**
 * 推送完整 Agent 目录，让客户端及时更新在线状态。
 * @returns 无返回值。
 */
function publishAgents() {
  broadcast({
    type: 'agents.snapshot',
    agents: [...(process.env.LOCAL_CLAUDE === '0' ? [] : [localAgent()]), ...listAgents()],
  });
}

/**
 * 只允许已知操作名称，并去除重复声明。
 * @param value 需要校验、散列或转换的输入值。
 * @returns 校验并去重后的能力列表。
 */
function capabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((c) => !CAPABILITIES.includes(c)))
    fail(400, 'Invalid capabilities');
  return [...new Set(value)];
}

/**
 * 更新可展示资料及能力，保留 Agent 身份和凭据。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @returns 保存成功标记。
 */
export function configureAgent(agentId: string, body: AgentProfile) {
  const row = getAgent(agentId);
  const data = {
    ...parsed(row),
    name: string(body.name, 'name', 200),
    nodeName: string(body.nodeName, 'nodeName', 200),
    provider: string(body.provider, 'provider', 100),
    capabilities: capabilities(body.capabilities ?? []),
  };
  repository.updateAgentProfile(JSON.stringify(data), agentId);
  publishAgent(agentId);
  return { ok: true };
}

/**
 * 创建独立主机身份与令牌，拒绝重复身份覆盖原凭据。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @returns 只在首次注册返回的接入凭据。
 */
export function registerAgent(body: AgentProfile) {
  const nodeId = string(body.nodeId, 'nodeId');
  const agentKey = string(body.agentKey, 'agentKey');
  const capabilities = body.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some((c) => !CAPABILITIES.includes(c))) {
    fail(400, 'Invalid capabilities');
  }
  const data = {
    nodeId,
    nodeName: string(body.nodeName, 'nodeName', 200),
    agentKey,
    name: string(body.name, 'name', 200),
    provider: string(body.provider, 'provider', 100),
    capabilities: [...new Set(capabilities)],
    protocolVersion: 1,
  };
  if (repository.findAgentIdentity(nodeId, agentKey)) {
    fail(
      409,
      'Agent already registered; reuse its saved credentials or choose a different agentKey',
    );
  }
  const agentId = randomUUID();
  const token = randomBytes(32).toString('hex');
  repository.insertAgent(agentId, nodeId, agentKey, hash(token), JSON.stringify(data), Date.now());
  publishAgents();
  return {
    agentId,
    token,
    protocolVersion: 1,
    heartbeatIntervalMs: Math.max(100, Math.floor(HEARTBEAT_MS / 3)),
  };
}

/**
 * 通过专用令牌散列确认 Agent 身份。
 * @param token 待验证或用于认证的凭据。
 * @returns 中心 Agent ID；无效令牌抛出认证错误。
 */
export function authenticateAgent(token: string): string {
  if (!token) fail(401, 'Agent token required');
  const row = repository.findAgentByToken(hash(token));
  if (!row) fail(401, 'Invalid agent token');
  return row.id;
}

/**
 * 刷新 Agent 在线时间，使过期判断基于最新心跳。
 * @param agentId 中心分配的 Agent 身份标识。
 * @returns 心跳受理确认。
 */
export function heartbeat(agentId: string) {
  const wasOnline = online(getAgent(agentId));
  repository.updateHeartbeat(Date.now(), agentId);
  if (!wasOnline) publishAgent(agentId);
  return { ok: true };
}

/**
 * 在指定 Agent 的命名空间查找会话，拒绝跨主机访问。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param remoteId Agent 自己使用的远程实体标识。
 * @returns 已确认归属的会话行。
 */
function ownedSession(agentId: string, remoteId: string): RemoteSessionRow {
  const row = remoteSession(entityId(agentId, 'session', string(remoteId, 'sessionId')));
  if (!row) fail(404, 'Session not found; publish the session first');
  return row;
}

/**
 * 保留客户端兼容字段，并附加中心会话 ID。
 * @param row 由仓储返回的持久化记录。
 * @returns 会话摘要。
 */
function sessionJson(row: RemoteSessionRow): SessionView {
  return { ...parsed(row), session_id: row.id };
}

/**
 * 读取同一中心项目的会话并按最近活动排序。
 * @param projectId 目标项目标识。
 * @returns 会话摘要列表。
 */
export function listRemoteSessions(projectId: string): SessionView[] {
  return repository
    .listSessions(projectId)
    .map(sessionJson)
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

/**
 * 只公开尚未结束且仍有效的远程审批。
 * @returns 待处理审批视图。
 */
export function listRemoteApprovals(): ApprovalView[] {
  return repository
    .listPendingApprovals(Date.now())
    .map((row) => ({ ...parsed(row), status: row.status }));
}

/**
 * 聚合主机、会话和审批，优先显示需要人工处理的状态。
 * @param id 待处理实体的稳定标识。
 * @returns 完整项目视图，项目不存在时为 null。
 */
export function getRemoteProject(id: string): ProjectView | null {
  const row = remoteProject(id);
  if (!row) return null;
  const agent = agentJson(getAgent(row.agent_id));
  const sessions = listRemoteSessions(id);
  const approval = listRemoteApprovals().find((a) => a.projectId === id);
  const active = sessions.find((s) => s.session_id === approval?.sessionId) ?? sessions[0];
  return {
    ...parsed(row),
    cwd: parsed(row).cwd || '',
    projectId: id,
    agentId: agent.agentId,
    agentName: agent.name,
    provider: agent.provider,
    nodeId: agent.nodeId,
    nodeName: agent.nodeName,
    online: agent.online,
    capabilities: agent.capabilities,
    status: approval ? 'needs_approval' : (active?.status ?? 'waiting_input'),
    activeSessionId: active?.session_id ?? null,
    summary: active?.summary ?? null,
    lastEventAt: active?.updated_at ?? 0,
    sessionCount: sessions.length,
    sessions,
    pendingApproval: approval ?? null,
  };
}

/**
 * 构建全部远程项目视图，保留各 Agent 的独立命名空间。
 * @returns 远程项目列表。
 */
export function listRemoteProjects(): ProjectView[] {
  return repository
    .listProjectIds()
    .map((row) => getRemoteProject(row.id))
    .filter((project): project is ProjectView => project !== null);
}

/**
 * 只广播发生变化的项目，避免重复发送完整快照。
 * @param id 待处理实体的稳定标识。
 * @returns 无返回值。
 */
function publishProject(id: string) {
  const project = getRemoteProject(id);
  if (project) broadcast({ type: 'project.update', project });
}

/**
 * 同时更新 Agent 在线信息及其所属项目。
 * @param id 待处理实体的稳定标识。
 * @returns 无返回值。
 */
function publishAgent(id: string) {
  publishAgents();
  for (const row of repository.listAgentProjectIds(id)) publishProject(row.id);
}

/**
 * 校验项目归属与时间，允许明确授权的主机索引调整项目。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @returns 稳定的中心项目和会话 ID。
 */
export function upsertRemoteSession(agentId: string, body: SessionInput) {
  const project: Partial<RemoteProjectInput> = body.project ?? {};
  const session: Partial<SessionInput['session']> = body.session ?? {};
  const projectKey = string(project.id, 'project.id');
  const sessionKey = string(session.id, 'session.id');
  const projectId = entityId(agentId, 'project', projectKey);
  const sessionId = entityId(agentId, 'session', sessionKey);
  const existing = remoteSession(sessionId);
  if (existing && existing.project_id !== projectId && body.allowProjectMove !== true)
    fail(409, 'Session belongs to another project');
  const previous: Partial<SessionView> = parsed(existing) ?? {};
  const updatedAt = session.updatedAt ?? Date.now();
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || updatedAt > Date.now() + 300000)
    fail(400, 'Invalid updatedAt');
  const projectData = {
    name: string(project.name, 'project.name', 200),
    cwd: optional(project.cwd, 'cwd', 4096),
    saved: project.saved === true,
  };
  const sessionData = {
    cwd: optional(session.cwd ?? projectData.cwd, 'session.cwd', 4096),
    summary: optional(session.summary ?? previous.summary, 'summary', 4000),
    status: status(session.status ?? previous.status ?? 'running'),
    started_at: previous.started_at ?? updatedAt,
    updated_at: updatedAt,
    capabilities:
      session.capabilities == null ? previous.capabilities : capabilities(session.capabilities),
    controlReason: optional(session.controlReason ?? previous.controlReason, 'controlReason', 1000),
    archived: session.archived === true,
    pinned: session.pinned === true,
    model: optional(session.model, 'model', 200),
    source: optional(session.source, 'source', 200),
    reasoningEffort: optional(session.reasoningEffort, 'reasoningEffort', 40),
    mode: optional(session.mode, 'mode', 40),
    controlTransport: optional(session.controlTransport, 'controlTransport', 80),
  };
  repository.upsertProject(projectId, agentId, projectKey, JSON.stringify(projectData));
  repository.upsertSession(sessionId, agentId, projectId, sessionKey, JSON.stringify(sessionData));
  if (existing && existing.project_id !== projectId) publishProject(existing.project_id);
  publishProject(projectId);
  return { projectId, sessionId };
}

/**
 * 保存主机项目元数据，使空项目也能进入列表。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param project 会话所属项目或项目摘要。
 * @returns 中心项目 ID。
 */
export function upsertRemoteProject(agentId: string, project: RemoteProjectInput) {
  const key = string(project.id, 'project.id');
  const id = entityId(agentId, 'project', key);
  const data = {
    name: string(project.name, 'project.name', 200),
    cwd: optional(project.cwd, 'cwd', 4096),
    saved: project.saved === true,
  };
  repository.upsertProject(id, agentId, key, JSON.stringify(data));
  publishProject(id);
  return { projectId: id };
}

/**
 * 保存合并后的会话状态，并由业务层决定推送时机。
 * @param row 由仓储返回的持久化记录。
 * @param changes 只包含本次变化的字段。
 * @returns 无返回值。
 */
function updateSession(row: RemoteSessionRow, changes: Partial<SessionView>) {
  repository.updateSession(JSON.stringify({ ...parsed(row), ...changes }), row.id);
  publishProject(row.project_id);
}

/**
 * 把持久远程事件转换为客户端兼容格式。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 最近的会话事件。
 */
export function readRemoteEvents(sessionId: string): TaskEvent[] {
  return repository
    .readEvents(sessionId)
    .map((row) => ({ ...parsed(row), id: row.id, session_id: row.session_id }));
}

const historyRequests = new Map<string, Promise<HistoryPage>>();
/**
 * 按能力选择本地分页或主机读取，并合并相同的在途分页请求。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param cursor 数据来源生成的下一页游标。
 * @param limit 单次返回的数据条数上限。
 * @returns 事件页与下一页游标。
 */
export async function readRemoteHistory(
  sessionId: string,
  cursor?: string | null,
  limit = 40,
): Promise<HistoryPage> {
  const session = remoteSession(sessionId);
  if (!session) fail(404, 'Session not found');
  const agent = getAgent(session.agent_id);
  if (!parsed(agent).capabilities.includes('history.read')) {
    const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 0) fail(400, 'Invalid history cursor');
    const rows = repository.readHistory(sessionId, before, limit + 1);
    return {
      events: rows.slice(0, limit).map((r) => ({ ...parsed(r), id: r.id, session_id: sessionId })),
      nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null,
    };
  }
  const key = `${sessionId}:${cursor || ''}:${limit}`;
  if (historyRequests.has(key)) return historyRequests.get(key)!;
  const request = (async () => {
    const command = queueCommand(
      session.agent_id,
      'history.read',
      { sessionId: session!.remote_id, cursor, limit },
      { sessionId },
    );
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = commandInfo(command.commandId);
      if (result.status === 'failed') fail(502, result.result?.error || 'History request failed');
      if (result.status === 'succeeded') {
        const page = result.result?.result as HistoryPage | undefined;
        if (!page || !Array.isArray(page.events)) fail(502, 'Invalid history response');
        repository.updateCommandResult(
          JSON.stringify({ ok: true, result: null }),
          command.commandId,
        );
        return {
          ...page,
          events: page.events.map((event) => ({ ...event, session_id: sessionId })),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fail(504, '读取历史超时，请重试');
  })();
  historyRequests.set(key, request);
  try {
    return await request;
  } finally {
    historyRequests.delete(key);
  }
}

const EVENT_NAMES: Record<string, string> = {
  'message.user': 'UserPromptSubmit',
  'message.assistant': 'AssistantText',
  thinking: 'Thinking',
  'tool.started': 'PreToolUse',
  'tool.finished': 'PostToolUse',
  'tool.output': 'ToolOutput',
  'task.status': 'TaskStatus',
};

/**
 * 区分瞬时流式片段与持久事件，只有最终事件参加去重存储。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @returns 受理结果及可选的重复标记。
 */
export function appendRemoteEvent(
  agentId: string,
  body: EventInput & {
    /** 中心或主机会话标识，由所属契约确定。 */
    sessionId: string;
  },
) {
  const row = ownedSession(agentId, body.sessionId);
  const type = string(body.type, 'type', 100);
  const text = optional(body.text, 'text', 256000);
  const phase = ['commentary', 'final_answer'].includes(body.phase || '') ? body.phase : null;
  const turnId = optional(body.turnId, 'turnId', 200) || null;
  const itemId = optional(body.itemId, 'itemId', 200) || null;
  if (body.ok != null && typeof body.ok !== 'boolean') fail(400, 'Invalid ok');
  if (body.status != null) status(body.status);
  if (['assistant.start', 'assistant.delta', 'assistant.done'].includes(type)) {
    if (type === 'assistant.start')
      updateSession(row, { status: 'running', updated_at: Date.now() });
    if (type === 'assistant.done')
      updateSession(row, {
        status: body.aborted ? 'paused' : body.ok === false ? 'error' : 'done',
        updated_at: Date.now(),
      });
    broadcast({
      type,
      sessionId: row.id,
      text,
      phase,
      turnId,
      itemId,
      ok: body.ok ?? true,
      error: optional(body.error, 'error', 2000) || null,
      aborted: body.aborted === true,
    });
    return { ok: true };
  }
  if (!EVENT_NAMES[type]) fail(400, 'Unsupported event type');
  const eventKey = `${row.id}:${string(body.eventId, 'eventId')}`;
  const event = {
    event_key: body.eventId,
    hook_event_name: EVENT_NAMES[type],
    detail: text,
    tool_name: optional(body.toolName, 'toolName', 200) || null,
    tool_call_id: optional(body.toolCallId, 'toolCallId', 512) || null,
    tool_input: optional(body.toolInput, 'toolInput', 64000) || null,
    turn_id: turnId,
    item_id: itemId,
    phase,
    status: body.status ?? parsed(row).status,
    summary: optional(body.summary, 'summary', 4000),
    ok: body.ok ?? null,
    created_at:
      typeof body.createdAt === 'number' &&
      Number.isSafeInteger(body.createdAt) &&
      body.createdAt >= 0 &&
      body.createdAt <= Date.now() + 300000
        ? body.createdAt
        : Date.now(),
  };
  const inserted = repository.insertEvent(agentId, row.id, eventKey, JSON.stringify(event));
  if (!inserted.changes) return { ok: true, duplicate: true };
  if (body.status) updateSession(row, { status: body.status, updated_at: Date.now() });
  broadcast({
    type: 'event.append',
    sessionId: row.id,
    event: { ...event, id: Number(inserted.lastInsertRowid), session_id: row.id },
  });
  return { ok: true };
}

/**
 * 校验 Agent 能力和输入问题结构，再保存有时限的审批。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @returns 已保存的审批视图。
 */
export function requestRemoteApproval(agentId: string, body: ApprovalInput): ApprovalView {
  const agent = agentJson(getAgent(agentId));
  if (!agent.capabilities.includes('approval.respond'))
    fail(409, 'Agent does not support approvals');
  const row = ownedSession(agentId, body.sessionId);
  const remoteId = string(body.id, 'id');
  const id = entityId(agentId, 'approval', remoteId);
  const existing = remoteApproval(id);
  if (existing) {
    if (existing.session_id !== row.id) fail(409, 'Approval belongs to another session');
    return { ...parsed(existing), status: existing.status };
  }
  const ttl = body.ttlMs ?? 1800000;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 1800000)
    fail(400, 'ttlMs must be 1000..1800000');
  const kind = body.kind ?? 'command';
  if (!['command', 'file_edit', 'input'].includes(kind)) fail(400, 'Invalid approval kind');
  let questions;
  if (kind === 'input') {
    if (!Array.isArray(body.questions) || !body.questions.length || body.questions.length > 10)
      fail(400, 'Invalid questions');
    questions = body.questions.map((q) => ({
      id: string(q.id, 'question.id', 100),
      question: string(q.question, 'question', 4000),
      isSecret: q.isSecret === true,
      options: (Array.isArray(q.options) ? q.options : []).slice(0, 20).map((o) => ({
        label: string(o.label, 'option.label', 1000),
        description: optional(o.description, 'option.description', 2000),
      })),
    }));
    if (new Set(questions.map((q) => q.id)).size !== questions.length)
      fail(400, 'Duplicate question ID');
  }
  const a = {
    approvalId: id,
    projectId: row.project_id,
    sessionId: row.id,
    kind,
    title: string(body.title, 'title', 1000),
    command: optional(body.command, 'command'),
    filePath: optional(body.filePath, 'filePath', 4096),
    diff: optional(body.diff, 'diff'),
    risk: body.risk === 'danger' ? 'danger' : 'normal',
    options: ['once', 'reject'],
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    status: 'pending',
    questions,
  };
  repository.insertApproval(
    id,
    agentId,
    row.id,
    remoteId,
    JSON.stringify(a),
    'pending',
    a.expiresAt,
  );
  broadcast({ type: 'approval.request', approval: a });
  publishProject(row.project_id);
  return a;
}

/**
 * 接受主机提前结束审批，并取消尚未投递的关联命令。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param remoteId Agent 自己使用的远程实体标识。
 * @param outcome 主机确认的最终审批结果。
 * @returns 最终审批状态。
 */
export function closeRemoteApproval(agentId: string, remoteId: string, outcome = 'expired') {
  if (!['approved', 'denied', 'expired'].includes(outcome)) fail(400, 'Invalid approval outcome');
  const row = remoteApproval(entityId(agentId, 'approval', string(remoteId, 'approvalId')));
  if (!row) fail(404, 'Approval not found');
  if (row.status !== 'pending') return { ok: true, status: row.status };
  const next = row.expires_at <= Date.now() ? 'expired' : outcome;
  repository.updateApprovalStatus(next, row.id);
  for (const command of repository.listApprovalCommands(row.id)) {
    finishCommand(command, { ok: false, error: '审批已在 Agent 端结束，操作已取消' });
  }
  broadcast({
    type: 'approval.resolved',
    approvalId: row.id,
    by: 'agent',
    decision: next === 'denied' ? 'reject' : null,
  });
  publishProject(remoteSession(row.session_id)!.project_id);
  return { ok: true, status: next };
}

/**
 * 查询命令并结算已经超时的状态，不把未知结果当作成功。
 * @param id 待处理实体的稳定标识。
 * @returns 命令状态与最终回执。
 */
export function commandInfo(id: string): CommandView {
  let row = repository.findCommand(id)!;
  if (!row) fail(404, 'Command not found');
  if (['queued', 'delivered'].includes(row.status) && row.expires_at <= Date.now()) {
    finishCommand(row, {
      ok: false,
      error:
        row.status === 'queued'
          ? 'Agent 未接收操作，已过期'
          : '操作回执超时，执行结果未知；请核对 Agent 状态',
    });
    row = repository.findCommand(id)!;
  }
  return {
    commandId: row.id,
    operation: row.type,
    status: row.status,
    sessionId: row.session_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    result: row.result ? JSON.parse(row.result) : null,
  };
}

/**
 * 校验在线状态和能力，以请求键去重后持久化操作。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param type 领域事件或操作的类别。
 * @param payload 当前操作、事件或 hook 的负载。
 * @param options 本次操作的具名参数，缺省值由实现统一处理。
 * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param options.approvalId 待处理审批的标识。
 * @param options.requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 中心命令状态，重复请求复用原命令。
 */
export function queueCommand(
  agentId: string,
  type: string,
  payload: CommandPayload,
  { sessionId = null, approvalId = null, requestId = randomUUID() }: QueueOptions = {},
): CommandView {
  const row = getAgent(agentId);
  if (!row || !online(row)) fail(409, 'Agent 离线，操作未发送');
  if (!parsed(row).capabilities.includes(type)) fail(409, '此 Agent 不支持该操作');
  string(requestId, 'requestId');
  const prior = repository.findRequestCommand(agentId, requestId);
  if (prior) {
    if (prior.type !== type || prior.payload !== JSON.stringify(payload))
      fail(409, 'requestId already used for a different operation');
    return commandInfo(prior.id);
  }
  const id = randomUUID();
  const expiresAt = Math.min(
    Date.now() + COMMAND_MS,
    approvalId ? remoteApproval(approvalId)!.expires_at : Infinity,
  );
  repository.insertCommand(
    id,
    agentId,
    sessionId,
    approvalId,
    requestId,
    type,
    JSON.stringify(payload),
    'queued',
    Date.now(),
    expiresAt,
  );
  agentNotifications.emit(agentId);
  return commandInfo(id);
}

/**
 * 同时遵守主机能力与会话能力，并转换为主机会话 ID。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param type 领域事件或操作的类别。
 * @param text 用户指令、输出或待处理文本。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 已入队的中心命令。
 */
export function queueSessionCommand(
  sessionId: string,
  type: string,
  text: unknown,
  requestId?: string,
) {
  const row = remoteSession(sessionId);
  if (!row) fail(404, 'Session not found');
  const payload: CommandPayload = { sessionId: row.remote_id };
  const session = parsed(row);
  if (session.capabilities && !session.capabilities.includes(type))
    fail(409, session.controlReason || '此任务不支持该操作');
  if (type === 'message.send' || type === 'message.steer')
    payload.text = string(text, 'text', 256000);
  return queueCommand(row.agent_id, type, payload, { sessionId, requestId });
}

/**
 * 先验证设置键，再向会话所属主机排队提交。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param settings 准备在下一轮生效的会话设置。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 设置命令的中心状态。
 */
export function queueSessionSettings(sessionId: string, settings: unknown, requestId?: string) {
  const row = remoteSession(sessionId);
  if (!row) fail(404, 'Session not found');
  const session = parsed(row);
  if (session.capabilities && !session.capabilities.includes('session.configure'))
    fail(409, session.controlReason || '此任务不支持修改设置');
  const checked = validateSettings(settings);
  return queueCommand(
    row.agent_id,
    'session.configure',
    { sessionId: row.remote_id, settings: checked },
    { sessionId, requestId },
  );
}

/**
 * 限制允许修改的设置项，禁止未知字段透传到主机。
 * @param settings 准备在下一轮生效的会话设置。
 * @returns 校验后的下一轮设置。
 */
export function validateSettings(settings: unknown): SessionSettings {
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    !Object.keys(settings).length
  )
    fail(400, 'Settings required');
  const allowed = new Set(['model', 'reasoningEffort', 'mode']);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!allowed.has(key)) fail(400, `Unsupported setting: ${key}`);
    result[key] = string(value, key, 200);
  }
  return result;
}

/**
 * 等待主机最终回执，超时只报告结果未知而不重放操作。
 * @param command 待执行命令或中心命令记录。
 * @param timeoutMs 等待主机回执的最大毫秒数。
 * @returns 主机确认的操作结果。
 */
export async function waitCommand(command: CommandView, timeoutMs = 30000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = commandInfo(command.commandId);
    if (current.status === 'succeeded') return current.result?.result;
    if (current.status === 'failed') fail(502, current.result?.error || '主机执行失败');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(504, '主机回执超时，结果未知，请检查状态后重试');
}

/**
 * 校验可选会话归属，再读取主机能力或执行公开动作。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param type 领域事件或操作的类别。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param payload 当前操作、事件或 hook 的负载。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 主机最终返回的数据。
 */
export async function agentRequest(
  agentId: string,
  type: string,
  sessionId?: string,
  payload: CommandPayload = {},
  requestId?: string,
) {
  let session;
  if (sessionId) {
    session = remoteSession(sessionId);
    if (!session || session.agent_id !== agentId) fail(404, 'Agent session not found');
  }
  if (!['agent.catalog', 'agent.action'].includes(type)) fail(400, 'Unsupported agent request');
  if (type === 'agent.action') {
    string(payload.name, 'action name', 100);
    if (
      !payload.arguments ||
      typeof payload.arguments !== 'object' ||
      Array.isArray(payload.arguments)
    )
      fail(400, 'Action arguments required');
  }
  return waitCommand(
    queueCommand(
      agentId,
      type,
      { ...payload, sessionId: session?.remote_id },
      { sessionId, requestId },
    ),
  );
}

/**
 * 预分配主机会话 ID，使网络重试不会新建重复会话。
 * @param projectId 目标项目标识。
 * @param text 用户指令、输出或待处理文本。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 新会话命令及中心关联信息。
 */
export function queueNewSession(projectId: string, text: string, requestId?: string) {
  const row = remoteProject(projectId);
  if (!row) fail(404, 'Project not found');
  string(text, 'text', 256000);
  if (requestId) {
    const prior = repository.findRequestCommand(row.agent_id, requestId);
    if (prior) {
      const payload = JSON.parse(prior.payload);
      if (
        prior.type !== 'session.start' ||
        payload.projectId !== row.remote_id ||
        payload.text !== text
      )
        fail(409, 'requestId already used');
      return commandInfo(prior.id);
    }
  }
  const remoteId = randomUUID();
  const sessionId = entityId(row.agent_id, 'session', remoteId);
  const result = queueCommand(
    row.agent_id,
    'session.start',
    { projectId: row.remote_id, sessionId: remoteId, text },
    { sessionId, requestId },
  );
  upsertRemoteSession(row.agent_id, {
    project: { ...parsed(row), id: row.remote_id },
    session: { id: remoteId, summary: text.slice(0, 200), status: 'waiting_input' },
  });
  return result;
}

/**
 * 验证审批仍有效并限制回复范围，审批不会在入队时提前成功。
 * @param id 待处理实体的稳定标识。
 * @param decision 用户选择的批准或拒绝决定。
 * @param scope 授权有效范围，通常为 once。
 * @param answers 按问题 ID 组织的用户回复。
 * @returns 已排队命令或先前的最终审批结果。
 */
export function queueApproval(
  id: string,
  decision: string,
  scope = 'once',
  answers?: Record<string, unknown>,
) {
  if (!['approve', 'reject'].includes(decision)) fail(400, 'Invalid decision');
  if (scope !== 'once') fail(400, 'Generic approvals only support scope=once');
  const row = remoteApproval(id);
  if (!row) fail(404, 'Approval not found');
  if (['approved', 'denied'].includes(row.status)) return { status: row.status, already: true };
  if (row.status !== 'pending' || row.expires_at <= Date.now())
    fail(409, 'Approval already resolved or expired');
  const payload: CommandPayload = { approvalId: row.remote_id, decision, scope };
  if (parsed(row).kind === 'input' && decision === 'approve') {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers))
      fail(400, 'Answers required');
    payload.answers = {};
    for (const q of parsed(row).questions || [])
      payload.answers[q.id] = string(answers[q.id], 'answer', 16000);
    if (
      Object.keys(answers).some((key) => !(parsed(row).questions || []).some((q) => q.id === key))
    )
      fail(400, 'Unknown question');
  }
  return queueCommand(row.agent_id, 'approval.respond', payload, {
    sessionId: row.session_id,
    approvalId: id,
    requestId: `approval:${id}`,
  });
}

/**
 * 先清理过期任务，再将领取的命令标记为已投递。
 * @param agentId 中心分配的 Agent 身份标识。
 * @returns 本轮可执行命令列表。
 */
export function takeCommands(agentId: string): AgentCommand[] {
  sweep();
  const rows = repository.listQueuedCommands(agentId);
  // Delivery is at most once: an uncertain receipt must never replay a tool action.
  for (const row of rows) repository.markDelivered(row.id);
  return rows.map((row) => ({
    commandId: row.id,
    type: row.type,
    payload: JSON.parse(row.payload),
    expiresAt: row.expires_at,
  }));
}

/**
 * 只接受所属 Agent 对已投递且未过期命令的回执。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param id 待处理实体的稳定标识。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @returns 命令最新状态。
 */
export function completeCommand(agentId: string, id: string, body: CommandReceipt) {
  const row = repository.findOwnedCommand(id, agentId);
  if (!row) fail(404, 'Command not found');
  if (typeof body.ok !== 'boolean') fail(400, 'ok must be boolean');
  if (!['queued', 'delivered'].includes(row.status)) return commandInfo(id);
  if (row.status !== 'delivered') fail(409, 'Command has not been delivered');
  if (row.expires_at <= Date.now()) {
    finishCommand(row, { ok: false, error: '操作回执超时，执行结果未知；请核对 Agent 状态' });
    return commandInfo(id);
  }
  finishCommand(row, {
    ok: body.ok,
    error: optional(body.error, 'error', 2000),
    result: body.result ?? null,
  });
  return commandInfo(id);
}

/**
 * 保存最终回执，并按真实执行结果结算关联审批和会话。
 * @param row 由仓储返回的持久化记录。
 * @param result 当前主机或存储操作的结果。
 * @returns 无返回值。
 */
function finishCommand(row: CommandRow, result: CommandReceipt) {
  repository.finishCommand(result.ok ? 'succeeded' : 'failed', JSON.stringify(result), row.id);
  if (!['history.read', 'agent.catalog', 'agent.action'].includes(row.type))
    broadcast({ type: 'command.result', ...commandInfo(row.id), approvalId: row.approval_id });
  if (row.approval_id && result.ok) {
    const approval = remoteApproval(row.approval_id)!;
    if (approval.status === 'pending' && approval.expires_at > Date.now()) {
      const approved = JSON.parse(row.payload).decision === 'approve';
      repository.updateApprovalStatus(approved ? 'approved' : 'denied', approval.id);
      broadcast({
        type: 'approval.resolved',
        approvalId: approval.id,
        by: 'agent',
        decision: approved ? 'approve' : 'reject',
      });
      const session = row.session_id ? remoteSession(row.session_id) : undefined;
      appendRemoteEvent(row.agent_id, {
        sessionId: session!.remote_id,
        eventId: `approval:${approval.id}`,
        type: 'task.status',
        status: approved ? 'running' : 'rejected',
        text: approved ? '已批准' : '已拒绝',
      });
    }
  }
  if (!result.ok && ['message.send', 'session.start'].includes(row.type)) {
    const session = row.session_id ? remoteSession(row.session_id) : undefined;
    if (session) updateSession(session, { status: 'error', updated_at: Date.now() });
    broadcast({
      type: 'assistant.done',
      sessionId: row.session_id,
      ok: false,
      error: result.error,
    });
  }
}

const presence = new Map<string, boolean>();
/**
 * 结算超时命令、过期审批及在线状态变化，避免遗留待办。
 * @returns 无返回值。
 */
export function sweep() {
  const now = Date.now();
  for (const row of repository.listExpiredCommands(now)) {
    finishCommand(row, {
      ok: false,
      error:
        row.status === 'queued'
          ? 'Agent 未接收操作，已过期'
          : '操作回执超时，执行结果未知；请核对 Agent 状态',
    });
  }
  for (const row of repository.listExpiredApprovals(now)) {
    repository.expireApproval(row.id);
    broadcast({ type: 'approval.resolved', approvalId: row.id, by: 'timeout' });
    const session = row.session_id ? remoteSession(row.session_id) : undefined;
    if (session) publishProject(session.project_id);
  }
  for (const row of repository.listAllAgents()) {
    const value = online(row);
    if (presence.get(row.id) !== value) {
      presence.set(row.id, value);
      publishAgent(row.id);
    }
  }
}

/**
 * 把重启前的在途操作标记为结果未知，再启动定期结算。
 * @returns 不阻止进程退出的周期计时器。
 */
export function startAgentLoop() {
  // A hub restart invalidates in-flight receipts without re-delivering commands.
  for (const row of repository.listDeliveredCommands()) {
    finishCommand(row, { ok: false, error: '中心服务已重启，操作执行结果未知；请核对 Agent 状态' });
  }
  return setInterval(sweep, Math.min(5000, Math.max(100, HEARTBEAT_MS / 3))).unref();
}
