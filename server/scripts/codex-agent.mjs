import path from 'node:path';
import { stat } from 'node:fs/promises';
import { AgentClient } from '../sdk/agent-client.mjs';
import { CodexRpc } from '../sdk/codex-rpc.mjs';
import { CodexAgent } from '../sdk/codex-agent.mjs';
import { CodexDesktop } from '../sdk/codex-desktop.mjs';

const projects = JSON.parse(process.env.CODEX_PROJECTS || JSON.stringify([process.cwd()]));
if (!Array.isArray(projects) || !projects.length || projects.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) {
  throw new Error('CODEX_PROJECTS 必须是主机上绝对项目路径组成的 JSON 数组');
}
for (const project of projects) if (!(await stat(project)).isDirectory()) throw new Error(`项目目录不存在：${project}`);
const rpc = new CodexRpc({ url: process.env.CODEX_APP_SERVER_URL, token: process.env.CODEX_APP_SERVER_TOKEN });
let adapter;
const onError = (error) => console.error('[codex-agent]', error.message);
const client = new AgentClient({
  hubUrl: process.env.HUB_URL || 'http://127.0.0.1:4820', enrollmentToken: process.env.HUB_TOKEN,
  nodeId: process.env.NODE_ID, nodeName: process.env.NODE_NAME,
  agentKey: process.env.AGENT_KEY || 'codex', name: process.env.AGENT_NAME || 'Codex', provider: 'codex',
  stateFile: process.env.AGENT_STATE_FILE, onError, isAvailable: () => rpc.ready && !adapter?.closed,
});
adapter = new CodexAgent({ rpc, client, projects, hostScope: process.env.CODEX_SCOPE === 'host', lazyHistory: true,
  desktop: !rpc.url && process.env.CODEX_DESKTOP !== '0' ? new CodexDesktop() : null,
  stateFile: process.env.CODEX_AGENT_STATE_FILE || `${client.stateFile}.threads.json`, onError });
client.handlers = adapter.handlers;
client.profile.capabilities = Object.keys(adapter.handlers);
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await adapter.close().catch(onError);
  process.exitCode = code;
  if (process.connected) process.disconnect();
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
process.on('message', (message) => { if (message?.type === 'shutdown') void close(); });
rpc.on('disconnect', () => { if (!closing) void close(1); });
try {
  await adapter.connect();
  console.log(`[codex-agent] ready: ${adapter.projects.size} directories, ${adapter.threads.size} sessions; ${adapter.hostScope ? 'whole host' : 'selected projects'}; ${rpc.url ? 'shared App Server' : 'local stdio App Server'}`);
} catch (error) { onError(error); await close(1); }
