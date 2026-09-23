/** LAN 数据仓储：集中 SQL 与行类型，服务层只处理归属、幂等和状态转换。 */
import db, { prepare } from '../infrastructure/database.js';
import type {
  AgentRow,
  RemoteSessionRow,
  ProjectRow,
  RemoteApprovalRow,
  RemoteEventRow,
  CommandRow,
} from '../types/storage.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS lan_agents (
    id TEXT PRIMARY KEY, node_id TEXT NOT NULL, agent_key TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL, last_seen INTEGER NOT NULL,
    UNIQUE(node_id, agent_key)
  );
  CREATE TABLE IF NOT EXISTS lan_projects (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, remote_id TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lan_sessions (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT NOT NULL,
    remote_id TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lan_sessions_project ON lan_sessions(project_id);
  CREATE TABLE IF NOT EXISTS lan_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    event_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(agent_id, event_key)
  );
  CREATE INDEX IF NOT EXISTS lan_events_session ON lan_events(session_id, id);
  CREATE TABLE IF NOT EXISTS lan_approvals (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    remote_id TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lan_commands (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT, approval_id TEXT,
    request_key TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, result TEXT,
    UNIQUE(agent_id, request_key)
  );
`);

/**
 * 按中心 ID 查找 Agent 存储行。
 * @param id 待处理实体的稳定标识。
 * @returns 匹配行，未找到时为 undefined。
 */
export function findAgent(id: string) {
  return prepare<AgentRow>('SELECT * FROM lan_agents WHERE id=?').get(id);
}

/**
 * 按中心 ID 查找会话归属。
 * @param id 待处理实体的稳定标识。
 * @returns 匹配行，未找到时为 undefined。
 */
export function findSession(id: string) {
  return prepare<RemoteSessionRow>('SELECT * FROM lan_sessions WHERE id=?').get(id);
}

/**
 * 按中心 ID 查找项目归属。
 * @param id 待处理实体的稳定标识。
 * @returns 匹配行，未找到时为 undefined。
 */
export function findProject(id: string) {
  return prepare<ProjectRow>('SELECT * FROM lan_projects WHERE id=?').get(id);
}

/**
 * 按中心 ID 查找审批状态。
 * @param id 待处理实体的稳定标识。
 * @returns 匹配行，未找到时为 undefined。
 */
export function findApproval(id: string) {
  return prepare<RemoteApprovalRow>('SELECT * FROM lan_approvals WHERE id=?').get(id);
}

/**
 * 按最近心跳排序读取 Agent，在线状态由服务层计算。
 * @returns Agent 存储行列表。
 */
export function listAgents() {
  return prepare<AgentRow>('SELECT * FROM lan_agents ORDER BY last_seen DESC').all();
}

/**
 * 只更新资料列，保留稳定身份及令牌。
 * @param data 序列化正文或协议接收缓冲区。
 * @param id 待处理实体的稳定标识。
 * @returns SQLite 写入结果。
 */
export function updateAgentProfile(data: string, id: string) {
  return prepare('UPDATE lan_agents SET data=? WHERE id=?').run(data, id);
}

/**
 * 检查主机和 Agent 键是否已经注册，防止重复创建身份。
 * @param nodeId 持久主机标识。
 * @param agentKey 同一主机内稳定的接入端标识。
 * @returns 已注册的 ID，未找到时为 undefined。
 */
export function findAgentIdentity(nodeId: string, agentKey: string) {
  return prepare<Pick<AgentRow, 'id'>>(
    'SELECT id FROM lan_agents WHERE node_id=? AND agent_key=?',
  ).get(nodeId, agentKey);
}

/**
 * 持久化新身份与令牌散列，明文令牌只返回给注册方。
 * @param id 待处理实体的稳定标识。
 * @param nodeId 持久主机标识。
 * @param agentKey 同一主机内稳定的接入端标识。
 * @param tokenHash 已散列的凭据，数据库不保存明文。
 * @param data 序列化正文或协议接收缓冲区。
 * @param lastSeen Agent 最近心跳的毫秒时间戳。
 * @returns SQLite 写入结果。
 */
export function insertAgent(
  id: string,
  nodeId: string,
  agentKey: string,
  tokenHash: string,
  data: string,
  lastSeen: number,
) {
  return prepare('INSERT INTO lan_agents VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    nodeId,
    agentKey,
    tokenHash,
    data,
    lastSeen,
  );
}

/**
 * 通过令牌散列定位身份，数据库无需保存明文凭据。
 * @param tokenHash 已散列的凭据，数据库不保存明文。
 * @returns 匹配身份，未找到时为 undefined。
 */
export function findAgentByToken(tokenHash: string) {
  return prepare<AgentRow>('SELECT * FROM lan_agents WHERE token_hash=?').get(tokenHash);
}

/**
 * 只更新时间列，使资料更新与在线状态互不覆盖。
 * @param lastSeen Agent 最近心跳的毫秒时间戳。
 * @param id 待处理实体的稳定标识。
 * @returns SQLite 写入结果。
 */
export function updateHeartbeat(lastSeen: number, id: string) {
  return prepare('UPDATE lan_agents SET last_seen=? WHERE id=?').run(lastSeen, id);
}

/**
 * 按中心项目标识读取会话行，避免混入其他项目的记录。
 * @param projectId 目标项目标识。
 * @returns 该项目的会话记录。
 */
export function listSessions(projectId: string) {
  return prepare<RemoteSessionRow>('SELECT * FROM lan_sessions WHERE project_id=?').all(projectId);
}

/**
 * 只查询未解决且仍有效的审批。
 * @param now 本次过期结算使用的统一毫秒时间。
 * @returns 可供客户端处理的审批存储行。
 */
export function listPendingApprovals(now: number) {
  return prepare<RemoteApprovalRow>(
    "SELECT * FROM lan_approvals WHERE status='pending' AND expires_at>?",
  ).all(now);
}

/**
 * 查询项目标识，完整视图由服务层聚合。
 * @returns 项目 ID 列表。
 */
export function listProjectIds() {
  return prepare<Pick<ProjectRow, 'id'>>('SELECT id FROM lan_projects').all();
}

/**
 * 限定 Agent 范围读取项目，用于在线状态变更推送。
 * @param agentId 中心分配的 Agent 身份标识。
 * @returns 指定 Agent 的项目 ID 列表。
 */
export function listAgentProjectIds(agentId: string) {
  return prepare<Pick<ProjectRow, 'id'>>('SELECT id FROM lan_projects WHERE agent_id=?').all(
    agentId,
  );
}

/**
 * 按稳定中心 ID 保存项目，重复同步不会新增行。
 * @param id 待处理实体的稳定标识。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param remoteId Agent 自己使用的远程实体标识。
 * @param data 序列化正文或协议接收缓冲区。
 * @returns SQLite 写入结果。
 */
export function upsertProject(id: string, agentId: string, remoteId: string, data: string) {
  return prepare(`INSERT INTO lan_projects VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(id, agentId, remoteId, data);
}

/**
 * 保留首次开始时间，同时更新最新会话状态。
 * @param id 待处理实体的稳定标识。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param projectId 目标项目标识。
 * @param remoteId Agent 自己使用的远程实体标识。
 * @param data 序列化正文或协议接收缓冲区。
 * @returns SQLite 写入结果或写入完成信号。
 */
export function upsertSession(
  id: string,
  agentId: string,
  projectId: string,
  remoteId: string,
  data: string,
) {
  return prepare(`INSERT INTO lan_sessions VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, project_id=excluded.project_id`).run(
    id,
    agentId,
    projectId,
    remoteId,
    data,
  );
}

/**
 * 保存合并后的会话状态，并由业务层决定推送时机。
 * @param data 序列化正文或协议接收缓冲区。
 * @param id 待处理实体的稳定标识。
 * @returns 写入结果。
 */
export function updateSession(data: string, id: string) {
  return prepare('UPDATE lan_sessions SET data=? WHERE id=?').run(data, id);
}

/**
 * 按最新优先读取有限历史，避免单次请求加载无界事件。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 持久事件列表。
 */
export function readEvents(sessionId: string) {
  return prepare<RemoteEventRow>(
    'SELECT * FROM lan_events WHERE session_id=? ORDER BY id DESC LIMIT 2000',
  ).all(sessionId);
}

/**
 * 依据游标读取一页历史，避免重复读取完整正文。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param before 只读取小于此序号的历史事件。
 * @param limit 单次返回的数据条数上限。
 * @returns 事件分页结果。
 */
export function readHistory(sessionId: string, before: number, limit: number) {
  return prepare<RemoteEventRow>(
    'SELECT * FROM lan_events WHERE session_id=? AND id<? ORDER BY id DESC LIMIT ?',
  ).all(sessionId, before, limit);
}

/**
 * 更新命令结果列，可在正文读取后清除大块临时回执。
 * @param result 当前主机或存储操作的结果。
 * @param id 待处理实体的稳定标识。
 * @returns SQLite 写入结果。
 */
export function updateCommandResult(result: string, id: string) {
  return prepare('UPDATE lan_commands SET result=? WHERE id=?').run(result, id);
}

/**
 * 保存事件并保留去重约束，重复上报不重复追加。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param eventKey 跨重复同步保持稳定的事件去重键。
 * @param data 序列化正文或协议接收缓冲区。
 * @returns 写入结果或事件的存储序号。
 */
export function insertEvent(agentId: string, sessionId: string, eventKey: string, data: string) {
  return prepare(
    'INSERT OR IGNORE INTO lan_events (agent_id, session_id, event_key, data) VALUES (?, ?, ?, ?)',
  ).run(agentId, sessionId, eventKey, data);
}

/**
 * 保存审批正文及截止时间，重启后仍能判断是否过期。
 * @param id 待处理实体的稳定标识。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param remoteId Agent 自己使用的远程实体标识。
 * @param data 序列化正文或协议接收缓冲区。
 * @param status 本次保存或验证的状态。
 * @param expiresAt 超过该时间后不可再受理操作。
 * @returns SQLite 写入结果或写入完成信号。
 */
export function insertApproval(
  id: string,
  agentId: string,
  sessionId: string,
  remoteId: string,
  data: string,
  status: string,
  expiresAt: number,
) {
  return prepare('INSERT INTO lan_approvals VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    agentId,
    sessionId,
    remoteId,
    data,
    status,
    expiresAt,
  );
}

/**
 * 仅推进审批状态，保留原始请求用于审计。
 * @param status 本次保存或验证的状态。
 * @param id 待处理实体的稳定标识。
 * @returns SQLite 写入结果。
 */
export function updateApprovalStatus(status: string, id: string) {
  return prepare('UPDATE lan_approvals SET status=? WHERE id=?').run(status, id);
}

/**
 * 读取尚未投递的审批命令，供主机提前结束审批时取消。
 * @param approvalId 待处理审批的标识。
 * @returns 关联的排队命令。
 */
export function listApprovalCommands(approvalId: string) {
  return prepare<CommandRow>(
    "SELECT * FROM lan_commands WHERE approval_id=? AND status='queued'",
  ).all(approvalId);
}

/**
 * 通过中心命令 ID 查找投递与回执状态。
 * @param id 待处理实体的稳定标识。
 * @returns 匹配命令，未找到时为 undefined。
 */
export function findCommand(id: string) {
  return prepare<CommandRow>('SELECT * FROM lan_commands WHERE id=?').get(id);
}

/**
 * 以 Agent 和调用方请求键查询幂等记录。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param requestKey 调用方的幂等请求键。
 * @returns 先前命令，未找到时为 undefined。
 */
export function findRequestCommand(agentId: string, requestKey: string) {
  return prepare<CommandRow>('SELECT * FROM lan_commands WHERE agent_id=? AND request_key=?').get(
    agentId,
    requestKey,
  );
}

/**
 * 先保存操作及期限，再允许接入端领取。
 * @param id 待处理实体的稳定标识。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param approvalId 待处理审批的标识。
 * @param requestKey 调用方的幂等请求键。
 * @param type 领域事件或操作的类别。
 * @param payload 当前操作、事件或 hook 的负载。
 * @param status 本次保存或验证的状态。
 * @param createdAt 事件或命令发生的时间戳。
 * @param expiresAt 超过该时间后不可再受理操作。
 * @returns SQLite 写入结果。
 */
export function insertCommand(
  id: string,
  agentId: string,
  sessionId: string | null,
  approvalId: string | null,
  requestKey: string,
  type: string,
  payload: string,
  status: string,
  createdAt: number,
  expiresAt: number,
) {
  return prepare('INSERT INTO lan_commands VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
    id,
    agentId,
    sessionId,
    approvalId,
    requestKey,
    type,
    payload,
    status,
    createdAt,
    expiresAt,
  );
}

/**
 * 按创建顺序返回有限批次，避免一个 Agent 独占轮询周期。
 * @param agentId 中心分配的 Agent 身份标识。
 * @returns 当前 Agent 最早的一批排队命令。
 */
export function listQueuedCommands(agentId: string) {
  return prepare<CommandRow>(
    "SELECT * FROM lan_commands WHERE agent_id=? AND status='queued' ORDER BY created_at LIMIT 20",
  ).all(agentId);
}

/**
 * 标记已领取命令，结果不明时也不能重新执行同一操作。
 * @param id 待处理实体的稳定标识。
 * @returns SQLite 写入结果。
 */
export function markDelivered(id: string) {
  return prepare("UPDATE lan_commands SET status='delivered' WHERE id=?").run(id);
}

/**
 * 同时限定命令 ID 和 Agent，防止其他主机提交回执。
 * @param id 待处理实体的稳定标识。
 * @param agentId 中心分配的 Agent 身份标识。
 * @returns 匹配的命令行。
 */
export function findOwnedCommand(id: string, agentId: string) {
  return prepare<CommandRow>('SELECT * FROM lan_commands WHERE id=? AND agent_id=?').get(
    id,
    agentId,
  );
}

/**
 * 保存最终回执，并按真实执行结果结算关联审批和会话。
 * @param status 本次保存或验证的状态。
 * @param result 当前主机或存储操作的结果。
 * @param id 待处理实体的稳定标识。
 * @returns 完成保存和必要状态推送后返回。
 */
export function finishCommand(status: string, result: string, id: string) {
  return prepare('UPDATE lan_commands SET status=?, result=? WHERE id=?').run(status, result, id);
}

/**
 * 查找未完成且超时的操作，交由服务层结算未知结果。
 * @param now 本次过期结算使用的统一毫秒时间。
 * @returns 需要超时处理的命令。
 */
export function listExpiredCommands(now: number) {
  return prepare<CommandRow>(
    "SELECT * FROM lan_commands WHERE status IN ('queued','delivered') AND expires_at<=?",
  ).all(now);
}

/**
 * 查找仍待处理但已经超时的审批。
 * @param now 本次过期结算使用的统一毫秒时间。
 * @returns 需要标记过期的审批。
 */
export function listExpiredApprovals(now: number) {
  return prepare<RemoteApprovalRow>(
    "SELECT * FROM lan_approvals WHERE status='pending' AND expires_at<=?",
  ).all(now);
}

/**
 * 仅修改审批状态，不自动授权任何操作。
 * @param id 待处理实体的稳定标识。
 * @returns SQLite 写入结果。
 */
export function expireApproval(id: string) {
  return prepare("UPDATE lan_approvals SET status='expired' WHERE id=?").run(id);
}

/**
 * 读取持久身份，用于周期性重新计算在线状态。
 * @returns 全部 Agent 存储行。
 */
export function listAllAgents() {
  return prepare<AgentRow>('SELECT * FROM lan_agents').all();
}

/**
 * 找出重启前已投递命令，避免重新执行结果不明的操作。
 * @returns 需要在启动时结算的命令。
 */
export function listDeliveredCommands() {
  return prepare<CommandRow>("SELECT * FROM lan_commands WHERE status='delivered'").all();
}
