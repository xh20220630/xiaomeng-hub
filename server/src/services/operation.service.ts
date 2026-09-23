/** 业务服务协调本机和远程操作选择，通过仓储和适配器访问外部状态。 */
import {
  listSessions,
  readConversation,
  getProjectByDir,
  sessionInfo,
} from '../adapters/claude/transcript.js';
import { sendToSession, startSession, stopSession } from '../adapters/claude/cli.js';
import { respond } from './approval.service.js';
import { getPendingApprovals, approvalRowToJson } from '../repositories/local.repository.js';
import { broadcast } from '../events/hub-events.js';
import * as remote from './agent.service.js';
import { claudeCatalog, saveSessionSettings, sessionSettings } from './settings.service.js';
import { buildProjects } from './snapshot.service.js';

/**
 * 禁用本机适配器时拒绝访问其历史及操作入口。
 * @returns 无返回值。
 */
function localEnabled() {
  if (process.env.LOCAL_CLAUDE === '0') remote.fail(404, 'Local Claude adapter disabled');
}

/**
 * 校验目录标识并确认本机项目存在，防止目录穿越。
 * @param id 待处理实体的稳定标识。
 * @returns 已确认存在的本机项目。
 */
async function localProject(id: string) {
  localEnabled();
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/\0]/.test(id))
    remote.fail(400, 'Invalid project ID');
  const project = await getProjectByDir(id);
  if (!project) remote.fail(404, 'Project not found');
  return project;
}

/**
 * 校验 UUID 并确认本机会话文件存在。
 * @param id 待处理实体的稳定标识。
 * @returns 操作完成的异步信号。
 */
async function localSession(id: string) {
  localEnabled();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    remote.fail(404, 'Session not found');
  if (!(await sessionInfo(id))) remote.fail(404, 'Session not found');
}

/**
 * 按项目归属读取会话，避免跨 Agent 混用路径。
 * @param id 待处理实体的稳定标识。
 * @returns 该项目下的会话摘要。
 */
export async function projectSessions(id: string) {
  if (remote.remoteProject(id)) return remote.listRemoteSessions(id);
  await localProject(id);
  return (await listSessions(id)).map((session) => ({
    ...session,
    ...sessionSettings(session.session_id),
  }));
}

/**
 * 按数据来源读取历史，统一使用客户端事件结构。
 * @param id 待处理实体的稳定标识。
 * @returns 会话历史事件。
 */
export async function sessionEvents(id: string) {
  if (remote.remoteSession(id)) return remote.readRemoteEvents(id);
  await localSession(id);
  return readConversation(id);
}

/**
 * 校验分页参数后读取一页历史，游标由来源解释。
 * @param id 待处理实体的稳定标识。
 * @param cursor 数据来源生成的下一页游标。
 * @param limit 单次返回的数据条数上限。
 * @returns 当前页事件和下一页游标。
 */
export async function sessionHistory(id: string, cursor: string | undefined, limit: number) {
  if (remote.remoteSession(id)) return remote.readRemoteHistory(id, cursor, limit);
  const events = await sessionEvents(id);
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) remote.fail(400, 'Invalid history cursor');
  return {
    events: events.slice(offset, offset + limit),
    nextCursor: offset + limit < events.length ? String(offset + limit) : null,
  };
}

/**
 * 合并本机和远程仍有效的审批请求。
 * @returns 客户端需要处理的审批列表。
 */
export function pendingApprovals() {
  return [
    ...(process.env.LOCAL_CLAUDE === '0' ? [] : getPendingApprovals().map(approvalRowToJson)),
    ...remote.listRemoteApprovals(),
  ];
}

/**
 * 依据审批归属选择本机 gate 或远程回执流程。
 * @param id 待处理实体的稳定标识。
 * @param decision 用户选择的批准或拒绝决定。
 * @param scope 授权有效范围，通常为 once。
 * @param answers 按问题 ID 组织的用户回复。
 * @returns 已受理命令或已确定的审批状态。
 */
export function resolveApproval(
  id: string,
  decision: string,
  scope = 'once',
  answers?: Record<string, unknown>,
) {
  if (remote.remoteApproval(id))
    return { ok: true, ...remote.queueApproval(id, decision, scope, answers) };
  localEnabled();
  if (!['once', 'always'].includes(scope)) remote.fail(400, 'Invalid scope');
  const result = respond(id, decision, scope, 'app');
  if (!result.ok)
    remote.fail(result.error === 'not_found' ? 404 : 400, result.error || 'Approval failed');
  return result;
}

/**
 * 向会话所属执行通道发送指令，避免在错误主机启动任务。
 * @param id 待处理实体的稳定标识。
 * @param text 用户指令、输出或待处理文本。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 受理命令或主机轮次标识。
 */
export async function sendMessage(id: string, text: string, requestId?: string) {
  remote.string(text, 'text', 256000);
  if (remote.remoteSession(id))
    return { ok: true, ...remote.queueSessionCommand(id, 'message.send', text, requestId) };
  await localSession(id);
  void sendToSession(id, text).catch((e) =>
    broadcast({ type: 'assistant.done', sessionId: id, ok: false, error: e.message }),
  );
  return { ok: true, sessionId: id };
}

/**
 * 只允许已支持的停止动作，由任务所属主机实际执行。
 * @param id 待处理实体的稳定标识。
 * @param action 会话控制或公开主机动作。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 操作受理结果。
 */
export async function controlSession(id: string, action: string, requestId?: string) {
  if (action !== 'stop') remote.fail(400, 'Unsupported session action');
  if (remote.remoteSession(id))
    return { ok: true, ...remote.queueSessionCommand(id, 'session.stop', null, requestId) };
  await localSession(id);
  if (!stopSession(id)) remote.fail(409, '只能停止由本平台启动且仍在运行的任务');
  return { ok: true, sessionId: id };
}

/**
 * 向支持追加指令的执行中会话投递消息。
 * @param id 待处理实体的稳定标识。
 * @param text 用户指令、输出或待处理文本。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 中心记录的待执行命令。
 */
export function steerMessage(id: string, text: string, requestId?: string) {
  if (!remote.remoteSession(id)) remote.fail(409, '此 Agent 不支持运行中追加指令');
  return { ok: true, ...remote.queueSessionCommand(id, 'message.steer', text, requestId) };
}

/**
 * 为指定项目受理新会话，并沿用对应主机的能力约束。
 * @param id 待处理实体的稳定标识。
 * @param text 用户指令、输出或待处理文本。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 新会话标识或待确认的中心命令。
 */
export async function createSession(id: string, text: string, requestId?: string) {
  remote.string(text, 'text', 256000);
  if (remote.remoteProject(id)) return { ok: true, ...remote.queueNewSession(id, text, requestId) };
  const project = await localProject(id);
  return new Promise((resolve, reject) => {
    let sid: string | undefined;
    const timer = setTimeout(
      () =>
        reject(Object.assign(new Error('Agent 启动超时，请刷新会话列表确认状态'), { status: 504 })),
      60000,
    );
    startSession(project.cwd, text, {
      /**
       * 主机确认会话标识后推送初始化通知，使客户端关联后续增量。
       * @param sessionId 目标会话标识。
       * @returns 无返回值。
       */
      onInit: (sessionId) => {
        sid = sessionId;
        clearTimeout(timer);
        resolve({ ok: true, sessionId });
        broadcast({ type: 'assistant.start', sessionId });
      },
      /**
       * 把执行增量交给订阅方，减少等待完整结果的延迟。
       * @param value 本次回调收到的状态或文本。
       * @returns 无返回值。
       */
      onDelta: (value) => {
        if (sid) broadcast({ type: 'assistant.delta', sessionId: sid, text: value });
      },
    })
      .then((result) => {
        clearTimeout(timer);
        if (!sid)
          reject(Object.assign(new Error(result.error || 'Agent 启动失败'), { status: 502 }));
        if (sid && !result.aborted)
          broadcast({
            type: 'assistant.done',
            sessionId: sid,
            ok: !!result.ok,
            error: result.error,
          });
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * 获取指定主机实际提供的模型、模式和动作。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 主机能力目录。
 */
export async function agentCatalog(agentId: string, sessionId?: string) {
  if (agentId !== 'local-claude') return remote.agentRequest(agentId, 'agent.catalog', sessionId);
  localEnabled();
  if (sessionId) await localSession(sessionId);
  return claudeCatalog();
}

/**
 * 校验并保存下一轮设置，避免修改正在执行的轮次。
 * @param id 待处理实体的稳定标识。
 * @param settings 准备在下一轮生效的会话设置。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 主机确认的设置及生效范围。
 */
export async function configureSession(id: string, settings: unknown, requestId?: string) {
  if (remote.remoteSession(id))
    return remote.waitCommand(remote.queueSessionSettings(id, settings, requestId));
  await localSession(id);
  const checked = remote.validateSettings(settings),
    catalog = claudeCatalog();
  if (checked.model && !catalog.models.some((m) => m.id === checked.model))
    remote.fail(400, '主机未提供这个模型');
  if (
    checked.reasoningEffort &&
    !catalog.models[0]?.reasoningEfforts.includes(checked.reasoningEffort)
  )
    remote.fail(400, '不支持的推理强度');
  if (checked.mode && !catalog.modes.some((m) => m.id === checked.mode))
    remote.fail(400, '不支持的工作模式');
  const saved = saveSessionSettings(id, checked);
  broadcast({ type: 'session.settings', sessionId: id, settings: saved });
  const project = (await buildProjects()).find((p) => p.sessions?.some((s) => s.session_id === id));
  if (project) broadcast({ type: 'project.update', project });
  return { confirmed: true, appliesTo: 'next_turn', settings: saved };
}

/**
 * 仅向支持压缩能力的主机转发会话压缩请求。
 * @param id 待处理实体的稳定标识。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 主机确认的受理结果。
 */
export async function compactSession(id: string, requestId?: string) {
  if (remote.remoteSession(id))
    return remote.waitCommand(remote.queueSessionCommand(id, 'session.compact', null, requestId));
  remote.fail(409, '此 Agent 尚未提供远程压缩上下文');
}

/**
 * 调用主机公开的动作，返回确认后的结果。
 * @param agentId 中心分配的 Agent 身份标识。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param name 字段、能力或实体的展示名称。
 * @param args 固定命令行参数或主机动作参数。
 * @param requestId 用于关联回执及避免重复执行的请求标识。
 * @returns 主机动作执行结果。
 */
export async function agentAction(
  agentId: string,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown> = {},
  requestId?: string,
) {
  if (agentId !== 'local-claude')
    return remote.agentRequest(
      agentId,
      'agent.action',
      sessionId,
      { name, arguments: args },
      requestId,
    );
  localEnabled();
  remote.fail(409, '主机未提供此操作');
}
