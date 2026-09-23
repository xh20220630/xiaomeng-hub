import { AgentClient } from '../sdk/agent-client.mjs';
import { randomUUID } from 'node:crypto';

const project = { id: 'demo', name: '通用 Agent 演示', cwd: process.cwd() };
const running = new Map();
const pending = new Map();
const models = ['demo-balanced', 'demo-fast'];
const settings = new Map();
let client;

async function run(sessionId, text, controller) {
  try {
    await client.event(sessionId, 'assistant.start');
    await client.event(sessionId, 'message.user', { text });
    if (text.includes('/approve')) {
      const id = randomUUID();
      const decision = new Promise((resolve) => pending.set(id, { sessionId, resolve, expiresAt: Date.now() + 120000 }));
      const timer = setTimeout(() => { pending.get(id)?.resolve('reject'); pending.delete(id); }, 120000);
      try {
        await client.approval({ id, sessionId, title: '允许演示 Agent 继续回复？', command: '继续演示任务（无系统命令）', ttlMs: 120000 });
        if (await decision !== 'approve') throw new Error('用户拒绝或审批超时');
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
  } catch (error) {
    await client.event(sessionId, 'assistant.done', { ok: false, error: error.message, aborted: controller.signal.aborted }).catch(console.error);
  } finally { running.delete(sessionId); }
}

function send({ sessionId, text }) {
  if (running.has(sessionId)) throw new Error('当前会话仍在执行');
  const controller = new AbortController();
  running.set(sessionId, controller);
  void run(sessionId, text, controller);
  return { accepted: true };
}

client = new AgentClient({
  hubUrl: process.env.HUB_URL || 'http://localhost:4820', enrollmentToken: process.env.HUB_TOKEN,
  agentKey: process.env.AGENT_KEY || 'demo', name: process.env.AGENT_NAME || '示例 Agent', provider: 'demo',
  nodeId: process.env.NODE_ID, stateFile: process.env.AGENT_STATE_FILE,
  handlers: {
    'agent.catalog': () => ({ models: models.map((id) => ({ id, name: `${id}（演示）`, reasoningEfforts: [] })), modes: [], actions: [], settingsApply: 'next_turn' }),
    'session.configure': async ({ sessionId, settings: patch }) => {
      if (!models.includes(patch.model) || Object.keys(patch).some((key) => key !== 'model')) throw new Error('演示 Agent 仅支持演示模型');
      settings.set(sessionId, patch);
      await client.session(project, { id: sessionId, ...patch, status: running.has(sessionId) ? 'running' : 'waiting_input' });
      return { confirmed: true, appliesTo: 'next_turn', settings: patch };
    },
    'message.send': send,
    'session.start': async ({ sessionId, text }) => {
      await client.session(project, { id: sessionId, summary: text.slice(0, 200), status: 'running' });
      return send({ sessionId, text });
    },
    'session.stop': ({ sessionId }) => {
      const controller = running.get(sessionId);
      if (!controller) throw new Error('没有正在执行的任务');
      controller.abort(new Error('已停止'));
      for (const approval of pending.values()) if (approval.sessionId === sessionId) approval.resolve('reject');
      return { stopped: true };
    },
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
await client.session(project, { id: 'welcome', summary: '发送消息测试；包含 /approve 可测试审批', status: 'waiting_input' });
console.log('示例 Agent 已连接；在小梦中打开“通用 Agent 演示”发送消息。');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  for (const controller of running.values()) controller.abort(new Error('Agent 已关闭'));
  for (const approval of pending.values()) approval.resolve('reject');
  await client.close();
  process.exit(0);
});
