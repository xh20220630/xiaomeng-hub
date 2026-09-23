/** 仓储封装本机 Claude 会话与审批的存取，集中维护 SQL 与存储字段约定。 */
import db, { prepare } from '../infrastructure/database.js';
import type { ApprovalRow, LocalSessionRow, LocalEventRow } from '../types/storage.js';
import type { TaskEvent, ApprovalView, ProjectView } from '../types/domain.js';

// ---------- sessions ----------
const _upsert = prepare(`
  INSERT INTO sessions (session_id, cwd, status, last_event, last_tool, summary, started_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    cwd        = COALESCE(excluded.cwd, sessions.cwd),
    status     = excluded.status,
    last_event = excluded.last_event,
    last_tool  = COALESCE(excluded.last_tool, sessions.last_tool),
    summary    = excluded.summary,
    updated_at = excluded.updated_at
`);

/**
 * 保留首次开始时间，同时更新最新会话状态。
 * @param s hook 推导出的最新会话状态和摘要。
 * @returns 无返回值。
 */
export function upsertSession(
  s: Pick<
    LocalSessionRow,
    'session_id' | 'cwd' | 'status' | 'last_event' | 'last_tool' | 'summary'
  >,
) {
  const now = Date.now();
  _upsert.run(
    s.session_id,
    s.cwd ?? null,
    s.status,
    s.last_event,
    s.last_tool ?? null,
    s.summary,
    now,
    now,
  );
}

const _insertEvent = prepare(`
  INSERT INTO events (session_id, hook_event_name, tool_name, status, summary, detail, ok, raw_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * 追加本机 hook 事件，并返回数据库分配的顺序标识。
 * @param e 准备保存的事件。
 * @returns 新事件的存储序号。
 */
export function insertEvent(
  e: TaskEvent & {
    /** 兼容原协议的会话标识。 */
    session_id: string;
    /** 该实体当前的执行或处理状态。 */
    status: string;
    /** 用于列表展示的摘要。 */
    summary: string;
    /** 原始 hook 的审计文本。 */
    raw_json: string;
  },
) {
  const now = Date.now();
  const info = _insertEvent.run(
    e.session_id,
    e.hook_event_name,
    e.tool_name ?? null,
    e.status,
    e.summary,
    e.detail ?? null,
    e.ok === null || e.ok === undefined ? null : e.ok ? 1 : 0,
    e.raw_json,
    now,
  );
  return { id: Number(info.lastInsertRowid), created_at: now };
}

const _getSessions = prepare<LocalSessionRow>(`SELECT * FROM sessions ORDER BY updated_at DESC`);
/**
 * 读取本机最新会话状态，供项目聚合复用。
 * @returns 按更新时间排序的存储行。
 */
export function getSessions() {
  return _getSessions.all();
}

const _getSession = prepare<LocalSessionRow>(`SELECT * FROM sessions WHERE session_id = ?`);
/**
 * 通过本机会话 ID 读取当前摘要。
 * @param id 待处理实体的稳定标识。
 * @returns 匹配行，未找到时为 undefined。
 */
export function getSession(id: string) {
  return _getSession.get(id);
}

const _getEvents = prepare<LocalEventRow>(
  `SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
);
/**
 * 把 SQLite 的整数成功标记转换为协议布尔值。
 * @param id 待处理实体的稳定标识。
 * @param limit 单次返回的数据条数上限。
 * @returns 最近的事件列表。
 */
export function getEvents(id: string, limit = 200): TaskEvent[] {
  // `ok` is stored as INTEGER (0/1); normalize to a JSON boolean (or null) so it
  // matches the WebSocket event shape the client expects.
  return _getEvents.all(id, limit).map((r) => ({
    ...r,
    ok: r.ok === null || r.ok === undefined ? null : r.ok === 1,
  }));
}

// ---------- approvals ----------
const _insertApproval = prepare(`
  INSERT INTO approvals
    (approval_id, session_id, project_id, kind, title, command, file_path, diff, risk, options, status, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
`);

/**
 * 保存审批正文及截止时间，重启后仍能判断是否过期。
 * @param a 准备保存的审批。
 * @returns 无返回值。
 */
export function insertApproval(a: ApprovalView) {
  _insertApproval.run(
    a.approvalId,
    a.sessionId ?? null,
    a.projectId ?? null,
    a.kind,
    a.title,
    a.command ?? null,
    a.filePath ?? null,
    a.diff ?? null,
    a.risk ?? null,
    JSON.stringify(a.options ?? ['once', 'always', 'reject']),
    a.createdAt,
    a.expiresAt ?? null,
  );
}

const _resolveApproval = prepare(`
  UPDATE approvals SET status = ?, resolved_at = ?, decided_by = ?
  WHERE approval_id = ? AND status = 'pending'
`);
// Returns true if this call actually transitioned a pending row (idempotency guard).
/**
 * 仅修改 pending 行，使重复决策保持幂等。
 * @param approvalId 待处理审批的标识。
 * @param status 本次保存或验证的状态。
 * @param by 审批决定的来源标识。
 * @returns 本次调用是否真正改变了状态。
 */
export function resolveApprovalRow(approvalId: string, status: string, by?: string) {
  const info = _resolveApproval.run(status, Date.now(), by ?? null, approvalId);
  return info.changes > 0;
}

const _getApproval = prepare<ApprovalRow>(`SELECT * FROM approvals WHERE approval_id = ?`);
/**
 * 按本机审批 ID 读取持久状态。
 * @param id 待处理实体的稳定标识。
 * @returns 匹配行，未找到时为 undefined。
 */
export function getApprovalRow(id: string) {
  return _getApproval.get(id);
}

const _getPending = prepare<ApprovalRow>(
  `SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC`,
);
/**
 * 读取待处理的本机 gate 审批。
 * @returns 按创建时间排序的审批行。
 */
export function getPendingApprovals() {
  return _getPending.all();
}

const _getApprovals = prepare<ApprovalRow>(
  `SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`,
);
/**
 * 限制审计列表长度，避免加载全部历史审批。
 * @param limit 单次返回的数据条数上限。
 * @returns 最近的审批行。
 */
export function getApprovals(limit = 100) {
  return _getApprovals.all(limit);
}

// Expire pending approvals past their expires_at; returns the expired ids.
const _expire = prepare(
  `UPDATE approvals SET status='expired', resolved_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < ?`,
);
const _expiredIds = prepare<Pick<ApprovalRow, 'approval_id'>>(
  `SELECT approval_id FROM approvals WHERE status='expired' AND resolved_at=?`,
);
/**
 * 结算已过期的本机审批，供等待方退出长轮询。
 * @returns 本轮过期的审批 ID。
 */
export function expireApprovals() {
  const now = Date.now();
  const info = _expire.run(now, now);
  if (info.changes === 0) return [];
  return _expiredIds.all(now).map((r) => r.approval_id);
}

// ---------- projects (derived from sessions + pending approvals) ----------
/**
 * 同时支持 Windows 与 POSIX 路径的展示名称。
 * @param p 原始 hook 或模拟事件负载。
 * @returns 最后一个路径段，空路径返回 null。
 */
function basename(p: string | null | undefined) {
  if (!p) return null;
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * 把数据库列名和序列化选项转换为客户端审批结构。
 * @param r 需要映射到客户端格式的存储行。
 * @returns 可直接发送给客户端的审批对象。
 */
export function approvalRowToJson(r: ApprovalRow): ApprovalView {
  return {
    approvalId: r.approval_id,
    sessionId: r.session_id || 'unknown',
    projectId: r.project_id || 'unknown',
    kind: r.kind,
    title: r.title,
    command: r.command,
    filePath: r.file_path,
    diff: r.diff,
    risk: r.risk,
    options: (() => {
      try {
        return JSON.parse(r.options || '[]');
      } catch {
        return ['once', 'always', 'reject'];
      }
    })(),
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/**
 * 优先按工作目录聚合本机会话，目录缺失时用会话 ID 隔离。
 * @param cwd 主机执行任务的工作目录。
 * @param fallback 主要来源缺失时使用的兼容值。
 * @returns 稳定项目聚合键。
 */
export function projectIdForCwd(cwd: string | null | undefined, fallback: string): string {
  return cwd && cwd.length ? cwd : fallback;
}

/**
 * 把代表会话与待审批合成项目卡片。
 * @param session 当前会话或二维码会话数据。
 * @param approvalRow 可选的待处理审批记录。
 * @param key 用于队列、映射或去重的稳定键。
 * @returns 客户端项目视图。
 */
function toProject(
  session: LocalSessionRow,
  approvalRow: ApprovalRow | undefined,
  key: string,
): ProjectView {
  const ap = approvalRow ? approvalRowToJson(approvalRow) : null;
  return {
    projectId: key,
    name: basename(session.cwd) || (session.session_id || '').slice(0, 8),
    cwd: session.cwd || '',
    status: ap ? 'needs_approval' : session.status,
    activeSessionId: session.session_id,
    summary: session.summary,
    progress: null,
    pendingApproval: ap,
    lastEventAt: session.updated_at || 0,
  };
}

// Aggregates sessions by cwd (latest session per cwd wins) and attaches any
// pending approval for that session.
/**
 * 按工作目录聚合本机会话，并覆盖待审批状态。
 * @returns 按最近活动排序的项目列表。
 */
export function getProjects(): ProjectView[] {
  const sessions = getSessions();
  const pending = getPendingApprovals();
  const byCwd = new Map<string, LocalSessionRow>();
  for (const s of sessions) {
    const key = projectIdForCwd(s.cwd, s.session_id);
    const cur = byCwd.get(key);
    if (!cur || (s.updated_at || 0) > (cur.updated_at || 0)) byCwd.set(key, s);
  }
  const out = [];
  for (const [key, s] of byCwd) {
    const ap = pending.find((a) => a.session_id === s.session_id);
    out.push(toProject(s, ap, key));
  }
  out.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return out;
}

// Single project for the session's cwd (used to broadcast project.update).
/**
 * 从会话反查其项目，以便只推送受影响的卡片。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 项目视图，找不到会话时为 null。
 */
export function getProjectForSession(sessionId: string): ProjectView | null {
  const s = getSession(sessionId);
  if (!s) return null;
  const key = projectIdForCwd(s.cwd, s.session_id);
  const pending = getPendingApprovals().find((a) => a.session_id === sessionId);
  return toProject(s, pending, key);
}

export default db;
