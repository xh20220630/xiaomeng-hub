/** 进程入口只管理 HTTP/WebSocket 的启动、后台任务与关闭信号。 */
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { HOST, PORT, AUTH_TOKEN } from './config/env.js';
import { initWs, disconnectUnauthorizedClients } from './transport/websocket.js';
import { onClientMessage } from './controllers/websocket.controller.js';
import { allAgents } from './services/agent-directory.service.js';
import { buildProjects } from './services/snapshot.service.js';
import { startExpiryLoop } from './services/approval.service.js';
import { startAgentLoop } from './services/agent.service.js';
import { startWatcher } from './adapters/claude/watcher.js';
import * as operations from './services/operation.service.js';

if (!AUTH_TOKEN && allAgents().some((agent) => agent.agentId !== 'local-claude')) {
  throw new Error('AUTH_TOKEN is required when LAN agents are enrolled');
}

const { app, isAuthorized } = createApp();
const server = http.createServer(app);
process.on('message', (message) => {
  if (
    (message && typeof message === 'object' && 'type' in message ? message.type : undefined) ===
    'shutdown'
  ) {
    disconnectUnauthorizedClients(() => false);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
});
initWs(
  server,
  async () => ({
    projects: await buildProjects(),
    agents: allAgents(),
    approvals: operations.pendingApprovals(),
    sessions: [],
  }),
  onClientMessage,
  {
    authorizeToken: isAuthorized,
  },
);
startExpiryLoop();
startAgentLoop();
if (process.env.LOCAL_CLAUDE !== '0') startWatcher();

server.listen(PORT, HOST, () => {
  console.log('\n🛰  小梦 · LAN Agent Platform');
  console.log(
    `   listening on ${HOST}:${(server.address() as AddressInfo).port}${AUTH_TOKEN ? '  (auth: ON)' : '  (auth: off)'}`,
  );
  console.log(`   hook intake : POST http://localhost:${PORT}/hooks/event`);
  console.log(`   REST api    : GET  http://localhost:${PORT}/api/sessions`);
  console.log(`   pair phone  : http://localhost:${(server.address() as AddressInfo).port}/pair/`);
  printLanHints((server.address() as AddressInfo).port);
  console.log('');
});

/**
 * 输出手机可使用的 IPv4 地址，避免误把 loopback 地址用于跨设备连接。
 * @param port 实际监听端口，测试时可能由系统分配。
 * @returns 无返回值。
 */
function printLanHints(port: number) {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  if (ips.length) {
    console.log('   LAN access (enter one of these in the app settings):');
    for (const ip of ips) console.log(`     host ${ip}   ws://${ip}:${port}/ws`);
  }
}
