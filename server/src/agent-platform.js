import { createHash, randomBytes, randomUUID } from 'node:crypto';
import db from './db.js';
import { broadcast } from './ws.js';
import { localAgent } from './local-agent.js';
import { agentNotifications } from './agent-notify.js';

export const CAPABILITIES = ['message.send', 'message.steer', 'session.start', 'session.stop', 'approval.respond', 'history.read', 'agent.catalog', 'session.configure', 'session.compact', 'agent.action'];
const STATUSES = ['running', 'waiting_input', 'needs_approval', 'done', 'ended', 'error', 'paused', 'rejected'];
const HEARTBEAT_MS = Number(process.env.AGENT_OFFLINE_MS || 45000);
const COMMAND_MS = Number(process.env.AGENT_COMMAND_TIMEOUT_MS || 60000);

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

export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function string(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `Invalid ${name}`);
  return value;
}

function optional(value, name, max = 64000) {
  return value == null || value === '' ? '' : string(value, name, max);
}

function status(value) {
  if (!STATUSES.includes(value)) fail(400, 'Invalid task status');
  return value;
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
const entityId = (agentId, kind, remoteId) => `lan_${kind}_${hash(`${agentId}\0${remoteId}`).slice(0, 40)}`;
const parsed = (row) => row ? JSON.parse(row.data) : null;
const getAgent = (id) => db.prepare('SELECT * FROM lan_agents WHERE id=?').get(id);
const online = (row) => Date.now() - row.last_seen < HEARTBEAT_MS;
export const remoteSession = (id) => db.prepare('SELECT * FROM lan_sessions WHERE id=?').get(id);
export const remoteProject = (id) => db.prepare('SELECT * FROM lan_projects WHERE id=?').get(id);
export const remoteApproval = (id) => db.prepare('SELECT * FROM lan_approvals WHERE id=?').get(id);

function agentJson(row) {
  return { ...parsed(row), agentId: row.id, online: online(row), lastSeenAt: row.last_seen };
}

export function listAgents() {
  return db.prepare('SELECT * FROM lan_agents ORDER BY last_seen DESC').all().map(agentJson);
}

function publishAgents() {
  broadcast({ type: 'agents.snapshot', agents: [...(process.env.LOCAL_CLAUDE === '0' ? [] : [localAgent()]), ...listAgents()] });
}

function capabilities(value) {
  if (!Array.isArray(value) || value.some((c) => !CAPABILITIES.includes(c))) fail(400, 'Invalid capabilities');
  return [...new Set(value)];
}

export function configureAgent(agentId, body) {
  const row = getAgent(agentId);
  const data = { ...parsed(row), name: string(body.name, 'name', 200),
    nodeName: string(body.nodeName, 'nodeName', 200), provider: string(body.provider, 'provider', 100),
    capabilities: capabilities(body.capabilities ?? []) };
  db.prepare('UPDATE lan_agents SET data=? WHERE id=?').run(JSON.stringify(data), agentId);
  publishAgent(agentId);
  return { ok: true };
}

export function registerAgent(body) {
  const nodeId = string(body.nodeId, 'nodeId');
  const agentKey = string(body.agentKey, 'agentKey');
  const capabilities = body.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some((c) => !CAPABILITIES.includes(c))) {
    fail(400, 'Invalid capabilities');
  }
  const data = {
    nodeId, nodeName: string(body.nodeName, 'nodeName', 200),
    agentKey, name: string(body.name, 'name', 200), provider: string(body.provider, 'provider', 100),
    capabilities: [...new Set(capabilities)], protocolVersion: 1,
  };
  if (db.prepare('SELECT id FROM lan_agents WHERE node_id=? AND agent_key=?').get(nodeId, agentKey)) {
    fail(409, 'Agent already registered; reuse its saved credentials or choose a different agentKey');
  }
  const agentId = randomUUID();
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO lan_agents VALUES (?, ?, ?, ?, ?, ?)')
    .run(agentId, nodeId, agentKey, hash(token), JSON.stringify(data), Date.now());
  publishAgents();
  return { agentId, token, protocolVersion: 1, heartbeatIntervalMs: Math.max(100, Math.floor(HEARTBEAT_MS / 3)) };
}

export function authenticateAgent(token) {
  if (!token) fail(401, 'Agent token required');
  const row = db.prepare('SELECT * FROM lan_agents WHERE token_hash=?').get(hash(token));
  if (!row) fail(401, 'Invalid agent token');
  return row.id;
}

export function heartbeat(agentId) {
  const wasOnline = online(getAgent(agentId));
  db.prepare('UPDATE lan_agents SET last_seen=? WHERE id=?').run(Date.now(), agentId);
  if (!wasOnline) publishAgent(agentId);
  return { ok: true };
}

function ownedSession(agentId, remoteId) {
  const row = remoteSession(entityId(agentId, 'session', string(remoteId, 'sessionId')));
  if (!row) fail(404, 'Session not found; publish the session first');
  return row;
}

function sessionJson(row) {
  return { ...parsed(row), session_id: row.id };
}

export function listRemoteSessions(projectId) {
  return db.prepare('SELECT * FROM lan_sessions WHERE project_id=?').all(projectId)
    .map(sessionJson).sort((a, b) => b.updated_at - a.updated_at);
}

export function listRemoteApprovals() {
  return db.prepare("SELECT * FROM lan_approvals WHERE status='pending' AND expires_at>?").all(Date.now())
    .map((row) => ({ ...parsed(row), status: row.status }));
}

export function getRemoteProject(id) {
  const row = remoteProject(id);
  if (!row) return null;
  const agent = agentJson(getAgent(row.agent_id));
  const sessions = listRemoteSessions(id);
  const approval = listRemoteApprovals().find((a) => a.projectId === id);
  const active = sessions.find((s) => s.session_id === approval?.sessionId) ?? sessions[0];
  return {
    ...parsed(row), projectId: id, agentId: agent.agentId, agentName: agent.name,
    provider: agent.provider, nodeId: agent.nodeId, nodeName: agent.nodeName,
    online: agent.online, capabilities: agent.capabilities,
    status: approval ? 'needs_approval' : active?.status ?? 'waiting_input',
    activeSessionId: active?.session_id ?? null, summary: active?.summary ?? null,
    lastEventAt: active?.updated_at ?? 0, sessionCount: sessions.length, sessions,
    pendingApproval: approval ?? null,
  };
}

export function listRemoteProjects() {
  return db.prepare('SELECT id FROM lan_projects').all().map((row) => getRemoteProject(row.id));
}

function publishProject(id) {
  const project = getRemoteProject(id);
  if (project) broadcast({ type: 'project.update', project });
}

function publishAgent(id) {
  publishAgents();
  for (const row of db.prepare('SELECT id FROM lan_projects WHERE agent_id=?').all(id)) publishProject(row.id);
}

export function upsertRemoteSession(agentId, body) {
  const project = body.project ?? {};
  const session = body.session ?? {};
  const projectKey = string(project.id, 'project.id');
  const sessionKey = string(session.id, 'session.id');
  const projectId = entityId(agentId, 'project', projectKey);
  const sessionId = entityId(agentId, 'session', sessionKey);
  const existing = remoteSession(sessionId);
  if (existing && existing.project_id !== projectId && body.allowProjectMove !== true) fail(409, 'Session belongs to another project');
  const previous = parsed(existing) ?? {};
  const updatedAt = session.updatedAt ?? Date.now();
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || updatedAt > Date.now() + 300000) fail(400, 'Invalid updatedAt');
  const projectData = { name: string(project.name, 'project.name', 200), cwd: optional(project.cwd, 'cwd', 4096), saved: project.saved === true };
  const sessionData = {
    cwd: optional(session.cwd ?? projectData.cwd, 'session.cwd', 4096), summary: optional(session.summary ?? previous.summary, 'summary', 4000),
    status: status(session.status ?? previous.status ?? 'running'),
    started_at: previous.started_at ?? updatedAt, updated_at: updatedAt,
    capabilities: session.capabilities == null ? previous.capabilities : capabilities(session.capabilities),
    controlReason: optional(session.controlReason ?? previous.controlReason, 'controlReason', 1000),
    archived: session.archived === true, pinned: session.pinned === true,
    model: optional(session.model, 'model', 200), source: optional(session.source, 'source', 200),
    reasoningEffort: optional(session.reasoningEffort, 'reasoningEffort', 40), mode: optional(session.mode, 'mode', 40),
    controlTransport: optional(session.controlTransport, 'controlTransport', 80),
  };
  db.prepare(`INSERT INTO lan_projects VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(projectId, agentId, projectKey, JSON.stringify(projectData));
  db.prepare(`INSERT INTO lan_sessions VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, project_id=excluded.project_id`).run(sessionId, agentId, projectId, sessionKey, JSON.stringify(sessionData));
  if (existing && existing.project_id !== projectId) publishProject(existing.project_id);
  publishProject(projectId);
  return { projectId, sessionId };
}

export function upsertRemoteProject(agentId, project) {
  const key = string(project.id, 'project.id');
  const id = entityId(agentId, 'project', key);
  const data = { name: string(project.name, 'project.name', 200), cwd: optional(project.cwd, 'cwd', 4096), saved: project.saved === true };
  db.prepare(`INSERT INTO lan_projects VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(id, agentId, key, JSON.stringify(data));
  publishProject(id);
  return { projectId: id };
}

function updateSession(row, changes) {
  db.prepare('UPDATE lan_sessions SET data=? WHERE id=?').run(JSON.stringify({ ...parsed(row), ...changes }), row.id);
  publishProject(row.project_id);
}

export function readRemoteEvents(sessionId) {
  return db.prepare('SELECT * FROM lan_events WHERE session_id=? ORDER BY id DESC LIMIT 2000').all(sessionId)
    .map((row) => ({ ...parsed(row), id: row.id, session_id: row.session_id }));
}

const historyRequests = new Map();
export async function readRemoteHistory(sessionId, cursor, limit = 40) {
  const session = remoteSession(sessionId);
  if (!session) fail(404, 'Session not found');
  const agent = getAgent(session.agent_id);
  if (!parsed(agent).capabilities.includes('history.read')) {
    const before = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 0) fail(400, 'Invalid history cursor');
    const rows = db.prepare('SELECT * FROM lan_events WHERE session_id=? AND id<? ORDER BY id DESC LIMIT ?').all(sessionId, before, limit + 1);
    return { events: rows.slice(0, limit).map((r) => ({ ...parsed(r), id: r.id, session_id: sessionId })),
      nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null };
  }
  const key = `${sessionId}:${cursor || ''}:${limit}`;
  if (historyRequests.has(key)) return historyRequests.get(key);
  const request = (async () => {
    const command = queueCommand(session.agent_id, 'history.read', { sessionId: session.remote_id, cursor, limit }, { sessionId });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = commandInfo(command.commandId);
      if (result.status === 'failed') fail(502, result.result?.error || 'History request failed');
      if (result.status === 'succeeded') {
        const page = result.result?.result;
        if (!Array.isArray(page?.events)) fail(502, 'Invalid history response');
        db.prepare('UPDATE lan_commands SET result=? WHERE id=?').run(JSON.stringify({ ok: true, result: null }), command.commandId);
        return { ...page, events: page.events.map((event) => ({ ...event, session_id: sessionId })) };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fail(504, '读取历史超时，请重试');
  })();
  historyRequests.set(key, request);
  try { return await request; } finally { historyRequests.delete(key); }
}

const EVENT_NAMES = {
  'message.user': 'UserPromptSubmit', 'message.assistant': 'AssistantText', thinking: 'Thinking',
  'tool.started': 'PreToolUse', 'tool.finished': 'PostToolUse', 'tool.output': 'ToolOutput', 'task.status': 'TaskStatus',
};

export function appendRemoteEvent(agentId, body) {
  const row = ownedSession(agentId, body.sessionId);
  const type = string(body.type, 'type', 100);
  const text = optional(body.text, 'text', 256000);
  const phase = ['commentary', 'final_answer'].includes(body.phase) ? body.phase : null;
  const turnId = optional(body.turnId, 'turnId', 200) || null;
  const itemId = optional(body.itemId, 'itemId', 200) || null;
  if (body.ok != null && typeof body.ok !== 'boolean') fail(400, 'Invalid ok');
  if (body.status != null) status(body.status);
  if (['assistant.start', 'assistant.delta', 'assistant.done'].includes(type)) {
    if (type === 'assistant.start') updateSession(row, { status: 'running', updated_at: Date.now() });
    if (type === 'assistant.done') updateSession(row, { status: body.aborted ? 'paused' : body.ok === false ? 'error' : 'done', updated_at: Date.now() });
    broadcast({ type, sessionId: row.id, text, phase, turnId, itemId, ok: body.ok ?? true, error: optional(body.error, 'error', 2000) || null, aborted: body.aborted === true });
    return { ok: true };
  }
  if (!EVENT_NAMES[type]) fail(400, 'Unsupported event type');
  const eventKey = `${row.id}:${string(body.eventId, 'eventId')}`;
  const event = {
    event_key: body.eventId,
    hook_event_name: EVENT_NAMES[type], detail: text, tool_name: optional(body.toolName, 'toolName', 200) || null,
    tool_call_id: optional(body.toolCallId, 'toolCallId', 512) || null,
    tool_input: optional(body.toolInput, 'toolInput', 64000) || null,
    turn_id: turnId, item_id: itemId, phase,
    status: body.status ?? parsed(row).status, summary: optional(body.summary, 'summary', 4000),
    ok: body.ok ?? null, created_at: Number.isSafeInteger(body.createdAt) && body.createdAt >= 0 && body.createdAt <= Date.now() + 300000 ? body.createdAt : Date.now(),
  };
  const inserted = db.prepare('INSERT OR IGNORE INTO lan_events (agent_id, session_id, event_key, data) VALUES (?, ?, ?, ?)')
    .run(agentId, row.id, eventKey, JSON.stringify(event));
  if (!inserted.changes) return { ok: true, duplicate: true };
  if (body.status) updateSession(row, { status: body.status, updated_at: Date.now() });
  broadcast({ type: 'event.append', sessionId: row.id, event: { ...event, id: Number(inserted.lastInsertRowid), session_id: row.id } });
  return { ok: true };
}

export function requestRemoteApproval(agentId, body) {
  const agent = agentJson(getAgent(agentId));
  if (!agent.capabilities.includes('approval.respond')) fail(409, 'Agent does not support approvals');
  const row = ownedSession(agentId, body.sessionId);
  const remoteId = string(body.id, 'id');
  const id = entityId(agentId, 'approval', remoteId);
  const existing = remoteApproval(id);
  if (existing) {
    if (existing.session_id !== row.id) fail(409, 'Approval belongs to another session');
    return { ...parsed(existing), status: existing.status };
  }
  const ttl = body.ttlMs ?? 1800000;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 1800000) fail(400, 'ttlMs must be 1000..1800000');
  const kind = body.kind ?? 'command';
  if (!['command', 'file_edit', 'input'].includes(kind)) fail(400, 'Invalid approval kind');
  let questions;
  if (kind === 'input') {
    if (!Array.isArray(body.questions) || !body.questions.length || body.questions.length > 10) fail(400, 'Invalid questions');
    questions = body.questions.map((q) => ({ id: string(q.id, 'question.id', 100),
      question: string(q.question, 'question', 4000), isSecret: q.isSecret === true,
      options: (Array.isArray(q.options) ? q.options : []).slice(0, 20).map((o) => ({
        label: string(o.label, 'option.label', 1000), description: optional(o.description, 'option.description', 2000),
      })) }));
    if (new Set(questions.map((q) => q.id)).size !== questions.length) fail(400, 'Duplicate question ID');
  }
  const a = {
    approvalId: id, projectId: row.project_id, sessionId: row.id,
    kind, title: string(body.title, 'title', 1000), command: optional(body.command, 'command'),
    filePath: optional(body.filePath, 'filePath', 4096), diff: optional(body.diff, 'diff'),
    risk: body.risk === 'danger' ? 'danger' : 'normal', options: ['once', 'reject'],
    createdAt: Date.now(), expiresAt: Date.now() + ttl, status: 'pending',
    questions,
  };
  db.prepare('INSERT INTO lan_approvals VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, agentId, row.id, remoteId, JSON.stringify(a), 'pending', a.expiresAt);
  broadcast({ type: 'approval.request', approval: a });
  publishProject(row.project_id);
  return a;
}

export function closeRemoteApproval(agentId, remoteId, outcome = 'expired') {
  if (!['approved', 'denied', 'expired'].includes(outcome)) fail(400, 'Invalid approval outcome');
  const row = remoteApproval(entityId(agentId, 'approval', string(remoteId, 'approvalId')));
  if (!row) fail(404, 'Approval not found');
  if (row.status !== 'pending') return { ok: true, status: row.status };
  const next = row.expires_at <= Date.now() ? 'expired' : outcome;
  db.prepare('UPDATE lan_approvals SET status=? WHERE id=?').run(next, row.id);
  for (const command of db.prepare("SELECT * FROM lan_commands WHERE approval_id=? AND status='queued'").all(row.id)) {
    finishCommand(command, { ok: false, error: '审批已在 Agent 端结束，操作已取消' });
  }
  broadcast({ type: 'approval.resolved', approvalId: row.id, by: 'agent', decision: next === 'denied' ? 'reject' : null });
  publishProject(remoteSession(row.session_id).project_id);
  return { ok: true, status: next };
}

export function commandInfo(id) {
  let row = db.prepare('SELECT * FROM lan_commands WHERE id=?').get(id);
  if (!row) fail(404, 'Command not found');
  if (['queued', 'delivered'].includes(row.status) && row.expires_at <= Date.now()) {
    finishCommand(row, { ok: false, error: row.status === 'queued' ? 'Agent 未接收操作，已过期' : '操作回执超时，执行结果未知；请核对 Agent 状态' });
    row = db.prepare('SELECT * FROM lan_commands WHERE id=?').get(id);
  }
  return { commandId: row.id, operation: row.type, status: row.status, sessionId: row.session_id,
    createdAt: row.created_at, expiresAt: row.expires_at, result: row.result ? JSON.parse(row.result) : null };
}

export function queueCommand(agentId, type, payload, { sessionId = null, approvalId = null, requestId = randomUUID() } = {}) {
  const row = getAgent(agentId);
  if (!row || !online(row)) fail(409, 'Agent 离线，操作未发送');
  if (!parsed(row).capabilities.includes(type)) fail(409, '此 Agent 不支持该操作');
  string(requestId, 'requestId');
  const prior = db.prepare('SELECT * FROM lan_commands WHERE agent_id=? AND request_key=?').get(agentId, requestId);
  if (prior) {
    if (prior.type !== type || prior.payload !== JSON.stringify(payload)) fail(409, 'requestId already used for a different operation');
    return commandInfo(prior.id);
  }
  const id = randomUUID();
  const expiresAt = Math.min(Date.now() + COMMAND_MS, approvalId ? remoteApproval(approvalId).expires_at : Infinity);
  db.prepare('INSERT INTO lan_commands VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
    .run(id, agentId, sessionId, approvalId, requestId, type, JSON.stringify(payload), 'queued', Date.now(), expiresAt);
  agentNotifications.emit(agentId);
  return commandInfo(id);
}

export function queueSessionCommand(sessionId, type, text, requestId) {
  const row = remoteSession(sessionId);
  if (!row) fail(404, 'Session not found');
  const payload = { sessionId: row.remote_id };
  const session = parsed(row);
  if (session.capabilities && !session.capabilities.includes(type)) fail(409, session.controlReason || '此任务不支持该操作');
  if (type === 'message.send' || type === 'message.steer') payload.text = string(text, 'text', 256000);
  return queueCommand(row.agent_id, type, payload, { sessionId, requestId });
}

export function queueSessionSettings(sessionId, settings, requestId) {
  const row = remoteSession(sessionId);
  if (!row) fail(404, 'Session not found');
  const session = parsed(row);
  if (session.capabilities && !session.capabilities.includes('session.configure')) fail(409, session.controlReason || '此任务不支持修改设置');
  const checked = validateSettings(settings);
  return queueCommand(row.agent_id, 'session.configure', { sessionId: row.remote_id, settings: checked }, { sessionId, requestId });
}

export function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Object.keys(settings).length) fail(400, 'Settings required');
  const allowed = new Set(['model', 'reasoningEffort', 'mode']);
  const result = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!allowed.has(key)) fail(400, `Unsupported setting: ${key}`);
    result[key] = string(value, key, 200);
  }
  return result;
}

export async function waitCommand(command, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = commandInfo(command.commandId);
    if (current.status === 'succeeded') return current.result?.result;
    if (current.status === 'failed') fail(502, current.result?.error || '主机执行失败');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(504, '主机回执超时，结果未知，请检查状态后重试');
}

export async function agentRequest(agentId, type, sessionId, payload = {}, requestId) {
  let session;
  if (sessionId) {
    session = remoteSession(sessionId);
    if (!session || session.agent_id !== agentId) fail(404, 'Agent session not found');
  }
  if (!['agent.catalog', 'agent.action'].includes(type)) fail(400, 'Unsupported agent request');
  if (type === 'agent.action') {
    string(payload.name, 'action name', 100);
    if (!payload.arguments || typeof payload.arguments !== 'object' || Array.isArray(payload.arguments)) fail(400, 'Action arguments required');
  }
  return waitCommand(queueCommand(agentId, type, { ...payload, sessionId: session?.remote_id }, { sessionId, requestId }));
}

export function queueNewSession(projectId, text, requestId) {
  const row = remoteProject(projectId);
  if (!row) fail(404, 'Project not found');
  string(text, 'text', 256000);
  if (requestId) {
    const prior = db.prepare('SELECT * FROM lan_commands WHERE agent_id=? AND request_key=?').get(row.agent_id, requestId);
    if (prior) {
      const payload = JSON.parse(prior.payload);
      if (prior.type !== 'session.start' || payload.projectId !== row.remote_id || payload.text !== text) fail(409, 'requestId already used');
      return commandInfo(prior.id);
    }
  }
  const remoteId = randomUUID();
  const sessionId = entityId(row.agent_id, 'session', remoteId);
  const result = queueCommand(row.agent_id, 'session.start', { projectId: row.remote_id, sessionId: remoteId, text }, { sessionId, requestId });
  upsertRemoteSession(row.agent_id, { project: { ...parsed(row), id: row.remote_id }, session: { id: remoteId, summary: text.slice(0, 200), status: 'waiting_input' } });
  return result;
}

export function queueApproval(id, decision, scope = 'once', answers) {
  if (!['approve', 'reject'].includes(decision)) fail(400, 'Invalid decision');
  if (scope !== 'once') fail(400, 'Generic approvals only support scope=once');
  const row = remoteApproval(id);
  if (!row) fail(404, 'Approval not found');
  if (['approved', 'denied'].includes(row.status)) return { status: row.status, already: true };
  if (row.status !== 'pending' || row.expires_at <= Date.now()) fail(409, 'Approval already resolved or expired');
  const payload = { approvalId: row.remote_id, decision, scope };
  if (parsed(row).kind === 'input' && decision === 'approve') {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) fail(400, 'Answers required');
    payload.answers = {};
    for (const q of parsed(row).questions) payload.answers[q.id] = string(answers[q.id], 'answer', 16000);
    if (Object.keys(answers).some((key) => !parsed(row).questions.some((q) => q.id === key))) fail(400, 'Unknown question');
  }
  return queueCommand(row.agent_id, 'approval.respond', payload, {
    sessionId: row.session_id, approvalId: id, requestId: `approval:${id}`,
  });
}

export function takeCommands(agentId) {
  sweep();
  const rows = db.prepare("SELECT * FROM lan_commands WHERE agent_id=? AND status='queued' ORDER BY created_at LIMIT 20").all(agentId);
  // Delivery is at most once: an uncertain receipt must never replay a tool action.
  for (const row of rows) db.prepare("UPDATE lan_commands SET status='delivered' WHERE id=?").run(row.id);
  return rows.map((row) => ({ commandId: row.id, type: row.type, payload: JSON.parse(row.payload), expiresAt: row.expires_at }));
}

export function completeCommand(agentId, id, body) {
  const row = db.prepare('SELECT * FROM lan_commands WHERE id=? AND agent_id=?').get(id, agentId);
  if (!row) fail(404, 'Command not found');
  if (typeof body.ok !== 'boolean') fail(400, 'ok must be boolean');
  if (!['queued', 'delivered'].includes(row.status)) return commandInfo(id);
  if (row.status !== 'delivered') fail(409, 'Command has not been delivered');
  if (row.expires_at <= Date.now()) {
    finishCommand(row, { ok: false, error: '操作回执超时，执行结果未知；请核对 Agent 状态' });
    return commandInfo(id);
  }
  finishCommand(row, { ok: body.ok, error: optional(body.error, 'error', 2000), result: body.result ?? null });
  return commandInfo(id);
}

function finishCommand(row, result) {
  db.prepare('UPDATE lan_commands SET status=?, result=? WHERE id=?')
    .run(result.ok ? 'succeeded' : 'failed', JSON.stringify(result), row.id);
  if (!['history.read', 'agent.catalog', 'agent.action'].includes(row.type)) broadcast({ type: 'command.result', ...commandInfo(row.id), approvalId: row.approval_id });
  if (row.approval_id && result.ok) {
    const approval = remoteApproval(row.approval_id);
    if (approval.status === 'pending' && approval.expires_at > Date.now()) {
      const approved = JSON.parse(row.payload).decision === 'approve';
      db.prepare('UPDATE lan_approvals SET status=? WHERE id=?').run(approved ? 'approved' : 'denied', approval.id);
      broadcast({ type: 'approval.resolved', approvalId: approval.id, by: 'agent', decision: approved ? 'approve' : 'reject' });
      const session = remoteSession(row.session_id);
      appendRemoteEvent(row.agent_id, { sessionId: session.remote_id, eventId: `approval:${approval.id}`, type: 'task.status',
        status: approved ? 'running' : 'rejected', text: approved ? '已批准' : '已拒绝' });
    }
  }
  if (!result.ok && ['message.send', 'session.start'].includes(row.type)) {
    const session = remoteSession(row.session_id);
    if (session) updateSession(session, { status: 'error', updated_at: Date.now() });
    broadcast({ type: 'assistant.done', sessionId: row.session_id, ok: false, error: result.error });
  }
}

const presence = new Map();
export function sweep() {
  const now = Date.now();
  for (const row of db.prepare("SELECT * FROM lan_commands WHERE status IN ('queued','delivered') AND expires_at<=?").all(now)) {
    finishCommand(row, { ok: false, error: row.status === 'queued' ? 'Agent 未接收操作，已过期' : '操作回执超时，执行结果未知；请核对 Agent 状态' });
  }
  for (const row of db.prepare("SELECT * FROM lan_approvals WHERE status='pending' AND expires_at<=?").all(now)) {
    db.prepare("UPDATE lan_approvals SET status='expired' WHERE id=?").run(row.id);
    broadcast({ type: 'approval.resolved', approvalId: row.id, by: 'timeout' });
    const session = remoteSession(row.session_id);
    if (session) publishProject(session.project_id);
  }
  for (const row of db.prepare('SELECT * FROM lan_agents').all()) {
    const value = online(row);
    if (presence.get(row.id) !== value) { presence.set(row.id, value); publishAgent(row.id); }
  }
}

export function startAgentLoop() {
  // A hub restart invalidates in-flight receipts without re-delivering commands.
  for (const row of db.prepare("SELECT * FROM lan_commands WHERE status='delivered'").all()) {
    finishCommand(row, { ok: false, error: '中心服务已重启，操作执行结果未知；请核对 Agent 状态' });
  }
  return setInterval(sweep, Math.min(5000, Math.max(100, HEARTBEAT_MS / 3))).unref();
}
