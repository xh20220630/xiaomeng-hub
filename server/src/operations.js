import { listSessions, readConversation, getProjectByDir, sessionInfo } from './claude-data.js';
import { sendToSession, startSession, stopSession } from './claude-cli.js';
import { respond } from './approvals.js';
import { getPendingApprovals, approvalRowToJson } from './db.js';
import { broadcast } from './ws.js';
import * as remote from './agent-platform.js';
import { claudeCatalog, saveSessionSettings, sessionSettings } from './agent-settings.js';
import { buildProjects } from './snapshot.js';

function localEnabled() {
  if (process.env.LOCAL_CLAUDE === '0') remote.fail(404, 'Local Claude adapter disabled');
}

async function localProject(id) {
  localEnabled();
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/\0]/.test(id)) remote.fail(400, 'Invalid project ID');
  const project = await getProjectByDir(id);
  if (!project) remote.fail(404, 'Project not found');
  return project;
}

async function localSession(id) {
  localEnabled();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) remote.fail(404, 'Session not found');
  if (!await sessionInfo(id)) remote.fail(404, 'Session not found');
}

export async function projectSessions(id) {
  if (remote.remoteProject(id)) return remote.listRemoteSessions(id);
  await localProject(id);
  return (await listSessions(id)).map((session) => ({ ...session, ...sessionSettings(session.session_id) }));
}

export async function sessionEvents(id) {
  if (remote.remoteSession(id)) return remote.readRemoteEvents(id);
  await localSession(id);
  return readConversation(id);
}

export async function sessionHistory(id, cursor, limit) {
  if (remote.remoteSession(id)) return remote.readRemoteHistory(id, cursor, limit);
  const events = await sessionEvents(id);
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) remote.fail(400, 'Invalid history cursor');
  return { events: events.slice(offset, offset + limit), nextCursor: offset + limit < events.length ? String(offset + limit) : null };
}

export function pendingApprovals() {
  return [...(process.env.LOCAL_CLAUDE === '0' ? [] : getPendingApprovals().map(approvalRowToJson)), ...remote.listRemoteApprovals()];
}

export function resolveApproval(id, decision, scope = 'once', answers) {
  if (remote.remoteApproval(id)) return { ok: true, ...remote.queueApproval(id, decision, scope, answers) };
  localEnabled();
  if (!['once', 'always'].includes(scope)) remote.fail(400, 'Invalid scope');
  const result = respond(id, decision, scope, 'app');
  if (!result.ok) remote.fail(result.error === 'not_found' ? 404 : 400, result.error);
  return result;
}

export async function sendMessage(id, text, requestId) {
  remote.string(text, 'text', 256000);
  if (remote.remoteSession(id)) return { ok: true, ...remote.queueSessionCommand(id, 'message.send', text, requestId) };
  await localSession(id);
  void sendToSession(id, text).catch((e) => broadcast({ type: 'assistant.done', sessionId: id, ok: false, error: e.message }));
  return { ok: true, sessionId: id };
}

export async function controlSession(id, action, requestId) {
  if (action !== 'stop') remote.fail(400, 'Unsupported session action');
  if (remote.remoteSession(id)) return { ok: true, ...remote.queueSessionCommand(id, 'session.stop', null, requestId) };
  await localSession(id);
  if (!stopSession(id)) remote.fail(409, '只能停止由本平台启动且仍在运行的任务');
  return { ok: true, sessionId: id };
}

export function steerMessage(id, text, requestId) {
  if (!remote.remoteSession(id)) remote.fail(409, '此 Agent 不支持运行中追加指令');
  return { ok: true, ...remote.queueSessionCommand(id, 'message.steer', text, requestId) };
}

export async function createSession(id, text, requestId) {
  remote.string(text, 'text', 256000);
  if (remote.remoteProject(id)) return { ok: true, ...remote.queueNewSession(id, text, requestId) };
  const project = await localProject(id);
  return new Promise((resolve, reject) => {
    let sid;
    const timer = setTimeout(() => reject(Object.assign(new Error('Agent 启动超时，请刷新会话列表确认状态'), { status: 504 })), 60000);
    startSession(project.cwd, text, {
      onInit: (sessionId) => {
        sid = sessionId;
        clearTimeout(timer);
        resolve({ ok: true, sessionId });
        broadcast({ type: 'assistant.start', sessionId });
      },
      onDelta: (value) => { if (sid) broadcast({ type: 'assistant.delta', sessionId: sid, text: value }); },
    }).then((result) => {
      clearTimeout(timer);
      if (!sid) reject(Object.assign(new Error(result.error || 'Agent 启动失败'), { status: 502 }));
      if (sid && !result.aborted) broadcast({ type: 'assistant.done', sessionId: sid, ok: !!result.ok, error: result.error });
    }).catch((error) => { clearTimeout(timer); reject(error); });
  });
}

export async function agentCatalog(agentId, sessionId) {
  if (agentId !== 'local-claude') return remote.agentRequest(agentId, 'agent.catalog', sessionId);
  localEnabled();
  if (sessionId) await localSession(sessionId);
  return claudeCatalog();
}

export async function configureSession(id, settings, requestId) {
  if (remote.remoteSession(id)) return remote.waitCommand(remote.queueSessionSettings(id, settings, requestId));
  await localSession(id);
  const checked = remote.validateSettings(settings), catalog = claudeCatalog();
  if (checked.model && !catalog.models.some((m) => m.id === checked.model)) remote.fail(400, '主机未提供这个模型');
  if (checked.reasoningEffort && !catalog.models[0]?.reasoningEfforts.includes(checked.reasoningEffort)) remote.fail(400, '不支持的推理强度');
  if (checked.mode && !catalog.modes.some((m) => m.id === checked.mode)) remote.fail(400, '不支持的工作模式');
  const saved = saveSessionSettings(id, checked);
  broadcast({ type: 'session.settings', sessionId: id, settings: saved });
  const project = (await buildProjects()).find((p) => p.sessions?.some((s) => s.session_id === id));
  if (project) broadcast({ type: 'project.update', project });
  return { confirmed: true, appliesTo: 'next_turn', settings: saved };
}

export async function compactSession(id, requestId) {
  if (remote.remoteSession(id)) return remote.waitCommand(remote.queueSessionCommand(id, 'session.compact', null, requestId));
  remote.fail(409, '此 Agent 尚未提供远程压缩上下文');
}

export async function agentAction(agentId, sessionId, name, args = {}, requestId) {
  if (agentId !== 'local-claude') return remote.agentRequest(agentId, 'agent.action', sessionId, { name, arguments: args }, requestId);
  localEnabled();
  remote.fail(409, '主机未提供此操作');
}
