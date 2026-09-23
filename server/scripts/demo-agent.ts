/** 开发与运维入口：演示 Agent 的命令与审批交互。 */
import type { CommandInput } from '../src/types/sdk.js';
import type { SessionSettings } from '../src/types/domain.js';
import { asError } from '../src/utils/errors.js';
import { AgentClient } from '../src/sdk/agent-client.js';
import { randomUUID } from 'node:crypto';

const project = { id: 'demo', name: '通用 Agent 演示', cwd: process.cwd() };
const running = new Map<string, AbortController>();
const pending = new Map<
  string,
  {
    /** 中心或主机会话标识，由所属契约确定。 */
    sessionId: string;
    /** 收到对应主机确认后完成等待。 */
    resolve: (decision: string) => void;
    /** 此操作或请求的失效时间。 */
    expiresAt: number;
  }
>();
const models = ['demo-balanced', 'demo-fast'];
const settings = new Map<string, SessionSettings>();
let client: AgentClient;

/**
 * 运行无模型调用的演示任务，提供真实停止和审批交互。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param text 用户指令、输出或待处理文本。
 * @param controller 控制演示任务取消的中止控制器。
 * @returns 操作完成的异步信号。
 */
async function run(sessionId: string, text: string, controller: AbortController) {
  try {
    await client.event(sessionId, 'assistant.start');
    await client.event(sessionId, 'message.user', { text });
    if (text.includes('/approve')) {
      const id = randomUUID();
      const decision = new Promise<string>((resolve) =>
        pending.set(id, { sessionId, resolve, expiresAt: Date.now() + 120000 }),
      );
      const timer = setTimeout(() => {
        pending.get(id)?.resolve('reject');
        pending.delete(id);
      }, 120000);
      try {
        await client.approval({
          id,
          sessionId,
          title: '允许演示 Agent 继续回复？',
          command: '继续演示任务（无系统命令）',
          ttlMs: 120000,
        });
        if ((await decision) !== 'approve') throw new Error('用户拒绝或审批超时');
      } finally {
        clearTimeout(timer);
        if (pending.has(id)) await client.resolveApproval(id).catch(console.error);
        pending.delete(id);
      }
    }
    const reply = `通用 Agent 已收到：${text}\n\n这条回复来自独立的 Agent 接入端。消息、停止和审批均通过中心服务路由。`;
    for (let i = 0; i < reply.length; i += 4) {
      controller.signal.throwIfAborted();
      await client.event(sessionId, 'assistant.delta', { text: reply.slice(0, i + 4) });
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await client.event(sessionId, 'message.assistant', { text: reply });
    await client.event(sessionId, 'assistant.done', { ok: true });
  } catch (cause) {
    const error = asError(cause);
    await client
      .event(sessionId, 'assistant.done', {
        ok: false,
        error: error.message,
        aborted: controller.signal.aborted,
      })
      .catch(console.error);
  } finally {
    running.delete(sessionId);
  }
}

/**
 * 只向已连接的主机通道写入协议数据。
 * @param options 本次操作的具名参数，缺省值由实现统一处理。
 * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param options.text 用户指令、输出或待处理文本。
 * @returns 写入完成或主机操作回执。
 */
function send({ sessionId, text }: CommandInput<'sessionId' | 'text'>) {
  if (running.has(sessionId)) throw new Error('当前会话仍在执行');
  const controller = new AbortController();
  running.set(sessionId, controller);
  void run(sessionId, text, controller);
  return { accepted: true };
}

client = new AgentClient({
  hubUrl: process.env.HUB_URL || 'http://localhost:4820',
  enrollmentToken: process.env.HUB_TOKEN,
  agentKey: process.env.AGENT_KEY || 'demo',
  name: process.env.AGENT_NAME || '示例 Agent',
  provider: 'demo',
  nodeId: process.env.NODE_ID,
  stateFile: process.env.AGENT_STATE_FILE,
  handlers: {
    /**
     * 按当前主机能力返回模型和操作目录，避免客户端硬编码选项。
     * @returns 可用能力目录。
     */
    'agent.catalog': () => ({
      models: models.map((id) => ({ id, name: `${id}（演示）`, reasoningEfforts: [] })),
      modes: [],
      actions: [],
      settingsApply: 'next_turn',
    }),
    /**
     * 交给主机验证并保存下一轮设置，避免在客户端猜测配置是否生效。
     * @param payload 该能力对应的命令负载。
     * @param payload.sessionId 目标会话标识。
     * @param payload.settings 下一轮执行配置。
     * @returns 已确认的执行设置或配置回执。
     */
    'session.configure': async ({ sessionId, settings: patch }) => {
      if (!models.includes(patch.model || '') || Object.keys(patch).some((key) => key !== 'model'))
        throw new Error('演示 Agent 仅支持演示模型');
      settings.set(sessionId, patch);
      await client.session(project, {
        id: sessionId,
        ...patch,
        status: running.has(sessionId) ? 'running' : 'waiting_input',
      });
      return { confirmed: true, appliesTo: 'next_turn', settings: patch };
    },
    'message.send': send,
    /**
     * 将新建命令交给当前适配器，沿用中心分配的会话标识。
     * @param payload 该能力对应的命令负载。
     * @param payload.sessionId 目标会话标识。
     * @param payload.text 用户要执行的指令。
     * @returns 主机创建会话的回执。
     */
    'session.start': async ({ sessionId, text }) => {
      await client.session(project, {
        id: sessionId,
        summary: text.slice(0, 200),
        status: 'running',
      });
      return send({ sessionId, text });
    },
    /**
     * 停止指定会话的当前执行，避免影响其他会话。
     * @param payload 该能力对应的命令负载。
     * @param payload.sessionId 目标会话标识。
     * @returns 停止操作的回执。
     */
    'session.stop': ({ sessionId }) => {
      const controller = running.get(sessionId);
      if (!controller) throw new Error('没有正在执行的任务');
      controller.abort(new Error('已停止'));
      for (const approval of pending.values())
        if (approval.sessionId === sessionId) approval.resolve('reject');
      return { stopped: true };
    },
    /**
     * 将手机决定交给审批所属主机，并等待明确确认。
     * @param payload 该能力对应的命令负载。
     * @param payload.approvalId 需要回复的审批标识。
     * @param payload.decision 用户选择的审批决定。
     * @returns 主机确认结果。
     */
    'approval.respond': ({ approvalId, decision }) => {
      const approval = pending.get(approvalId);
      if (!approval || approval.expiresAt <= Date.now()) throw new Error('审批已失效');
      approval.resolve(decision);
      pending.delete(approvalId);
      return { applied: true };
    },
  },
});
await client.connect();
await client.session(project, {
  id: 'welcome',
  summary: '发送消息测试；包含 /approve 可测试审批',
  status: 'waiting_input',
});
console.log('示例 Agent 已连接；在小梦中打开“通用 Agent 演示”发送消息。');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    for (const controller of running.values()) controller.abort(new Error('Agent 已关闭'));
    for (const approval of pending.values()) approval.resolve('reject');
    await client.close();
    process.exit(0);
  });
