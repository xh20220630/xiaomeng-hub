/** 开发与运维入口：连接并维护 Codex 接入端。 */
import { asError } from '../src/utils/errors.js';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { AgentClient } from '../src/sdk/agent-client.js';
import { CodexRpc } from '../src/adapters/codex/codex-rpc.js';
import { CodexAgent } from '../src/adapters/codex/codex-agent.js';
import { CodexDesktop } from '../src/adapters/codex/codex-desktop.js';

const projects = JSON.parse(process.env.CODEX_PROJECTS || JSON.stringify([process.cwd()]));
if (
  !Array.isArray(projects) ||
  !projects.length ||
  projects.some((p) => typeof p !== 'string' || !path.isAbsolute(p))
) {
  throw new Error('CODEX_PROJECTS 必须是主机上绝对项目路径组成的 JSON 数组');
}
for (const project of projects)
  if (!(await stat(project)).isDirectory()) throw new Error(`项目目录不存在：${project}`);
const rpc = new CodexRpc({
  url: process.env.CODEX_APP_SERVER_URL,
  token: process.env.CODEX_APP_SERVER_TOKEN,
});
let adapter: CodexAgent;
/**
 * 记录接入失败原因，供重连与运行状态诊断使用。
 * @param error 需要记录或交给等待方的错误。
 * @returns 无返回值。
 */
const onError = (error: Error) => console.error('[codex-agent]', error.message);
const client = new AgentClient({
  hubUrl: process.env.HUB_URL || 'http://127.0.0.1:4820',
  enrollmentToken: process.env.HUB_TOKEN,
  nodeId: process.env.NODE_ID,
  nodeName: process.env.NODE_NAME,
  agentKey: process.env.AGENT_KEY || 'codex',
  name: process.env.AGENT_NAME || 'Codex',
  provider: 'codex',
  stateFile: process.env.AGENT_STATE_FILE,
  onError,
  /**
   * 确认实际执行通道可用后才允许领取命令，避免接单后无法执行。
   * @returns 当前是否可以处理中心命令。
   */
  isAvailable: () => rpc.ready && !adapter?.closed,
});
adapter = new CodexAgent({
  rpc,
  client,
  projects,
  hostScope: process.env.CODEX_SCOPE === 'host',
  lazyHistory: true,
  desktop: !rpc.url && process.env.CODEX_DESKTOP !== '0' ? new CodexDesktop() : undefined,
  stateFile: process.env.CODEX_AGENT_STATE_FILE || `${client.stateFile}.threads.json`,
  onError,
});
client.handlers = adapter.handlers;
client.profile.capabilities = Object.keys(adapter.handlers);
let closing = false;
/**
 * 释放实例持有的连接和计时器，使停止后不再接收或发送任务。
 * @param code 进程最终退出码。
 * @returns 操作完成的异步信号。
 */
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await adapter.close().catch(onError);
  process.exitCode = code;
  if (process.connected) process.disconnect();
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
process.on('message', (message) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown')
    void close();
});
rpc.on('disconnect', () => {
  if (!closing) void close(1);
});
try {
  await adapter.connect();
  console.log(
    `[codex-agent] ready: ${adapter.projects.size} directories, ${adapter.threads.size} sessions; ${adapter.hostScope ? 'whole host' : 'selected projects'}; ${rpc.url ? 'shared App Server' : 'local stdio App Server'}`,
  );
} catch (cause) {
  const error = asError(cause);
  onError(error);
  await close(1);
}
