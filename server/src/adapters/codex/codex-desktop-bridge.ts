/** 桥接桌面持有的会话与中心操作，使手机指令进入原有执行通道。 */
import type { CodexAgent } from './codex-agent.js';
import type { CodexDesktop } from './codex-desktop.js';
import type { PendingApproval, ServerRequest, ThreadSettings } from '../../types/codex.js';
import type { CommandInput } from '../../types/sdk.js';
import { asError } from '../../utils/errors.js';
import { createHash } from 'node:crypto';
import { desktopTurns } from './codex-desktop.js';

/**
 * 为桌面请求生成稳定摘要，避免相同主机请求重复创建审批。
 * @param value 需要校验、散列或转换的输入值。
 * @returns 稳定去重键。
 */
const key = (value: string) => createHash('sha256').update(value).digest('hex');
const approvalMethods: Record<string, string> = {
  'item/commandExecution/requestApproval': 'command-approval-decision',
  'item/fileChange/requestApproval': 'file-approval-decision',
  'item/permissions/requestApproval': 'permissions-request-approval-response',
  'item/tool/requestUserInput': 'submit-user-input',
};

/** 复用桌面端持有的会话，避免另一执行通道抢占正在运行的任务。 */
export class CodexDesktopBridge {
  /** 执行领域同步与审批转换的 Codex 适配器。 */
  adapter: CodexAgent;
  /** 可选桌面桥接或桌面传输实例。 */
  desktop: CodexDesktop;
  /** 按会话合并短时间内连续状态更新的计时器。 */
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** 上次同步的轮次，用于判断开始与结束边界。 */
  lastTurns: Map<
    string,
    {
      /** 当前契约中的实体或活动标识。 */
      id?: string;
      /** 该实体当前的执行或处理状态。 */
      status?: string;
    }
  >;
  /** 已发送的文本快照，用于减少重复推送。 */
  outputs: Map<string, string | undefined>;
  /** 等待用户或主机最终确认的请求。 */
  requests: Map<string, PendingApproval>;

  /**
   * 建立实例独立的依赖与状态，避免不同接入端互相覆盖。
   * @param adapter 负责发布状态和操作路由的 Codex 适配器。
   * @param desktop 与现有 Codex 桌面拥有者通信的通道。
   * @returns 已初始化但尚未连接的实例。
   */
  constructor(adapter: CodexAgent, desktop: CodexDesktop) {
    this.adapter = adapter;
    this.desktop = desktop;
    this.timers = new Map();
    this.lastTurns = new Map();
    this.outputs = new Map();
    this.requests = new Map();
    desktop.on('warning', adapter.onError);
    desktop.on('state', (id: string) => {
      if (!this.timers.has(id))
        this.timers.set(
          id,
          setTimeout(() => {
            this.timers.delete(id);
            adapter.enqueue(() => this.project(id));
          }, 80),
        );
    });
    desktop.on('lost', (id: string) => {
      const thread = adapter.threads.get(id);
      if (thread) {
        thread.desktopOwned = false;
        adapter.enqueue(() => adapter.publish(thread));
      }
      for (const request of this.requests.values())
        if (request.params.threadId === id) {
          request.confirm?.reject(new Error('桌面已断开，审批结果未知'));
          this.requests.delete(request.id);
          adapter.enqueue(() => adapter.client.resolveApproval(request.id));
        }
    });
  }

  /**
   * 确认桌面连接仍持有目标会话的拥有者信息。
   * @param id 待处理实体的稳定标识。
   * @returns 是否可通过桌面通道操作。
   */
  has(id: string) {
    return this.desktop.has(id);
  }
  /**
   * 发现现有会话拥有者并跟随其状态，不打开第二个写入者。
   * @param id 待处理实体的稳定标识。
   * @returns 是否已找到并跟随主机会话。
   */
  async follow(id: string) {
    try {
      return await this.desktop.follow(id);
    } catch (cause) {
      const error = asError(cause);
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code || ''))
        this.adapter.onError(asError(error));
      return false;
    }
  }

  /**
   * 将桌面快照、运行轮次和待处理请求同步到 Agent，沿用桌面实际控制状态。
   * @param id 待处理实体的稳定标识。
   * @returns 操作完成的异步信号。
   */
  async project(id: string) {
    const state = this.desktop.states.get(id),
      adapter = this.adapter;
    if (!state || !this.has(id)) return;
    const turns = desktopTurns(state),
      last = turns.at(-1);
    const thread = {
      ...adapter.threads.get(id),
      id,
      cwd: state.cwd,
      name: state.title,
      status: state.threadRuntimeStatus,
      lastTurnStatus: last?.status,
      model: state.latestThreadSettings?.model || state.latestModel,
      reasoningEffort: state.latestThreadSettings?.effort || state.latestReasoningEffort,
      collaborationMode:
        state.latestThreadSettings?.collaborationMode || state.latestCollaborationMode,
      updatedAt: state.updatedAt / 1000,
      turns: last ? [{ id: last.turnId, status: last.status }] : [],
      desktopOwned: true,
    };
    if (!adapter.projectFor(thread)) return;
    adapter.threads.set(id, thread);
    await adapter.publish(thread);
    const previous = this.lastTurns.get(id);
    const running = last?.status === 'inProgress';
    if (running && (previous?.id !== last.turnId || previous.status !== 'inProgress'))
      await adapter.client.event(adapter.sessionId(id), 'assistant.start', { turnId: last.turnId });
    this.lastTurns.set(id, { id: last?.turnId, status: last?.status });
    if (last) {
      const latest = last.items?.at(-1);
      for (const item of last.items || []) {
        if (item.type === 'agentMessage' && running && latest === item) {
          const outputKey = `${id}:assistant`;
          if (this.outputs.get(outputKey) !== item.text) {
            this.outputs.set(outputKey, item.text);
            await adapter.client.event(adapter.sessionId(id), 'assistant.delta', {
              text: (item.text || '').slice(0, 256000),
              phase: item.phase,
              itemId: item.id,
              turnId: last.turnId,
            });
          }
        } else if (item.status === 'inProgress') {
          await adapter.item(id, last.turnId, item, false, last.turnStartedAtMs);
          if (
            item.type === 'commandExecution' &&
            this.outputs.get(`${id}:${item.id}`) !== item.aggregatedOutput
          ) {
            this.outputs.set(`${id}:${item.id}`, item.aggregatedOutput);
            await adapter.client.event(adapter.sessionId(id), 'tool.output', {
              toolName: 'Terminal',
              toolCallId: `${last.turnId}:${item.id}`,
              turnId: last.turnId,
              itemId: item.id,
              text: (item.aggregatedOutput || '').slice(-64000),
            });
          }
        } else await adapter.item(id, last.turnId, item, true, last.turnStartedAtMs);
      }
      if (latest?.type !== 'agentMessage' && this.outputs.has(`${id}:assistant`)) {
        this.outputs.delete(`${id}:assistant`);
        await adapter.client.event(adapter.sessionId(id), 'assistant.delta', { text: '' });
      }
    }
    if (!running && previous?.status === 'inProgress') {
      this.outputs.delete(`${id}:assistant`);
      await adapter.client.event(adapter.sessionId(id), 'assistant.done', {
        ok: last?.status !== 'failed',
        aborted: last?.status === 'interrupted',
      });
    }
    await this.syncRequests(id, state.requests || []);
  }

  /**
   * 根据桌面当前请求集合新增审批，并确认已由主机处理的旧请求。
   * @param id 待处理实体的稳定标识。
   * @param requests 桌面当前仍待回复的主机请求。
   * @returns 操作完成的异步信号。
   */
  async syncRequests(id: string, requests: ServerRequest[]) {
    const current = new Set();
    for (const raw of requests) {
      if (!approvalMethods[raw.method]) continue;
      const requestId = `desktop:${key(`${id}:${raw.id}`)}`;
      current.add(requestId);
      if (this.requests.has(requestId)) continue;
      const request: PendingApproval = {
        ...raw,
        rpcId: raw.id,
        id: requestId,
        params: { ...raw.params, threadId: id },
        expiresAt: Date.now() + this.adapter.approvalTtlMs,
      };
      this.requests.set(requestId, request);
      await this.adapter.publishRequest(request);
    }
    for (const request of this.requests.values())
      if (request.params.threadId === id && !current.has(request.id)) {
        this.requests.delete(request.id);
        request.confirm?.resolve({ confirmed: true });
        await this.adapter.client.resolveApproval(request.id, request.outcome || 'expired');
      }
  }

  /**
   * 只向已连接的主机通道写入协议数据。
   * @param id 待处理实体的稳定标识。
   * @param text 用户指令、输出或待处理文本。
   * @param steer 是否向当前轮次追加，而不是启动新轮次。
   * @returns 写入完成或主机操作回执。
   */
  async send(id: string, text: string, steer: boolean) {
    const state = await this.desktop.state(id);
    const input = [{ type: 'text', text, text_elements: [] }];
    if (steer) {
      const active = desktopTurns(state).at(-1);
      if (active?.status !== 'inProgress') throw new Error('本轮已结束，请刷新后发送新消息');
      return this.desktop.call(id, 'steer-turn', {
        input,
        attachments: [],
        restoreMessage: {
          id: key(text + Date.now()),
          text,
          cwd: state.cwd,
          createdAt: Date.now(),
          context: {
            prompt: text,
            addedFiles: [],
            fileAttachments: [],
            imageAttachments: [],
            workspaceRoots: [state.cwd],
          },
        },
      });
    }
    return this.desktop.call(id, 'start-turn', {
      turnStart: { request: { threadId: id, input }, context: { inheritThreadSettings: true } },
    });
  }

  /**
   * 针对当前执行通道停止指定轮次，不猜测其他客户端的状态。
   * @param id 待处理实体的稳定标识。
   * @returns 主机停止回执或关闭完成信号。
   */
  async stop(id: string) {
    const turn = desktopTurns(await this.desktop.state(id)).at(-1);
    if (!turn?.turnId || turn.status !== 'inProgress') throw new Error('当前没有可停止的执行轮次');
    return this.desktop.call(id, 'interrupt-turn', {
      mode: 'user-stop',
      expectedTurnId: turn.turnId,
    });
  }

  /**
   * 校验模型与推理强度的组合，再提交到当前主机控制通道。
   * @param id 待处理实体的稳定标识。
   * @param threadSettings 主机协议形式的线程设置。
   * @returns 主机确认的下一轮设置。
   */
  configure(id: string, threadSettings: ThreadSettings) {
    return this.desktop.call(id, 'update-thread-settings', { threadSettings });
  }
  /**
   * 仅在没有执行中轮次时申请压缩上下文。
   * @param id 待处理实体的稳定标识。
   * @returns 主机受理结果。
   */
  compact(id: string) {
    return this.desktop.call(id, 'compact-thread');
  }

  /**
   * 提交决策后等待主机确认，传输写入成功不等于审批成功。
   * @param payload 当前操作、事件或 hook 的负载。
   * @returns 明确主机确认，或以超时、断线错误拒绝。
   */
  async answer(payload: CommandInput<'approvalId' | 'decision'>) {
    const request = this.requests.get(payload.approvalId);
    if (!request || request.responding) throw new Error('问题已结束或正在处理');
    const response = this.adapter.response(request, payload);
    request.responding = true;
    request.outcome = payload.decision === 'approve' ? 'approved' : 'denied';
    const confirmation = new Promise<{
      /** 是否已得到主机的最终确认。 */
      confirmed: boolean;
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('桌面尚未确认审批，结果未知')), 20000);
      request.confirm = {
        /**
         * 完成请求并取消超时任务，避免已确认操作再次被报告为超时。
         * @param value 本次回调收到的状态或文本。
         * @returns 无返回值。
         */
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        /**
         * 传播执行失败并取消超时任务，保持最终结果唯一。
         * @param error 主机或传输层报告的失败。
         * @returns 无返回值。
         */
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
    confirmation.catch(() => {});
    try {
      await this.desktop.call(request.params.threadId, approvalMethods[request.method], {
        requestId: request.rpcId,
        ...(response.decision ? { decision: response.decision } : { response }),
      });
    } catch (cause) {
      const error = asError(cause);
      request.responding = false;
      request.confirm!.reject(error);
    }
    return confirmation;
  }

  /**
   * 释放实例持有的连接和计时器，使停止后不再接收或发送任务。
   * @returns 无返回值。
   */
  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.desktop.close();
  }
}
