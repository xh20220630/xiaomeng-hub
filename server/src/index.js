// Entry point: Express (REST + hook intake) and a WebSocket server sharing one
// HTTP server on PORT (default 4820), bound to 0.0.0.0 so phones on the same
// Wi-Fi can reach it.
//
// API/WS accept AUTH_TOKEN or an enrolled device token. Local hooks stay exempt;
// device credentials cannot enroll agents or authorize remote hooks.
import http from 'node:http';
import os from 'node:os';
import express from 'express';
import { initWs, disconnectUnauthorizedClients } from './ws.js';
import db from './db.js';
import { createPairing } from './pairing.js';
import hooksRouter from './hooks.js';
import apiRouter, { allAgents } from './api.js';
import { startExpiryLoop } from './approvals.js';
import { buildProjects } from './snapshot.js';
import { startWatcher } from './watcher.js';
import agentRouter from './agent-router.js';
import { startAgentLoop } from './agent-platform.js';
import * as operations from './operations.js';

const PORT = parseInt(process.env.PORT || '4820', 10);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
if (!AUTH_TOKEN && allAgents().some((agent) => agent.agentId !== 'local-claude')) {
  throw new Error('AUTH_TOKEN is required when LAN agents are enrolled');
}

const app = express();
const pairing = createPairing({ db, authToken: AUTH_TOKEN,
  onRevoke: () => disconnectUnauthorizedClients(isAuthorized),
  getAgents: allAgents,
});
function isAuthorized(token) {
  return !AUTH_TOKEN || token === AUTH_TOKEN || pairing.authorizeDevice(token);
}
app.get('/', (_req, res) => res.redirect('/pair/'));
app.use('/pair', pairing.router);
app.use(express.json({ limit: '5mb' }));

// Permissive CORS so a browser WS/REST client can be used for quick testing.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function requestToken(req) {
  const h = String(req.headers['authorization'] || '');
  if (h.startsWith('Bearer ')) return h.slice(7);
  const q = req.query?.token;
  return typeof q === 'string' ? q : '';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLoopback(req) {
  return LOOPBACK.has(req.socket?.remoteAddress || '');
}

// All /api endpoints require the token when AUTH_TOKEN is set (A11).
app.use('/api', (req, res, next) => {
  if (isAuthorized(requestToken(req))) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// Hook intake: local Claude Code always allowed; remote callers need the token.
app.use('/hooks', (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  if (isLoopback(req)) return next();
  if (requestToken(req) === AUTH_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
if (process.env.LOCAL_CLAUDE === '0') app.use('/hooks', (_req, res) => res.json({}));
else app.use('/hooks', hooksRouter);
app.use('/api', apiRouter);
app.use('/agent', agentRouter);
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[request]', err.message);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

// Upstream WS dispatch (App -> server).
async function onClientMessage(msg, socket) {
  try {
    let result;
    switch (msg?.type) {
      case 'approval.respond':
        console.log(`[ws] approval.respond ${String(msg.approvalId || '').slice(0, 8)} ${msg.decision}/${msg.scope || 'once'}`);
        result = operations.resolveApproval(msg.approvalId, msg.decision, msg.scope || 'once', msg.answers);
        break;
      case 'message.send':
        console.log(`[ws] message.send ${String(msg.sessionId || '').slice(0, 8)} len=${String(msg.text || '').length}`);
        result = await operations.sendMessage(msg.sessionId, msg.text, msg.requestId);
        break;
      case 'session.control':
        console.log(`[ws] session.control ${String(msg.sessionId || '').slice(0, 8)} -> ${msg.action}`);
        result = await operations.controlSession(msg.sessionId, msg.action, msg.requestId);
        break;
      case 'message.steer':
        result = operations.steerMessage(msg.sessionId, msg.text, msg.requestId);
        break;
      default: throw new Error('Unsupported operation');
    }
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'command.accepted', requestId: msg.requestId, ...result }));
  } catch (error) {
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify({ type: 'command.error', operation: msg?.type, sessionId: msg?.sessionId, approvalId: msg?.approvalId, error: error.message }));
    if (msg?.type === 'message.send') socket.send(JSON.stringify({ type: 'assistant.done', sessionId: msg.sessionId, ok: false, error: error.message }));
  }
}

const server = http.createServer(app);
process.on('message', (message) => {
  if (message?.type === 'shutdown') {
    disconnectUnauthorizedClients(() => false);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
});
initWs(server, async () => ({ projects: await buildProjects(), agents: allAgents(), approvals: operations.pendingApprovals(), sessions: [] }), onClientMessage, {
  authorizeToken: isAuthorized,
});
startExpiryLoop();
startAgentLoop();
if (process.env.LOCAL_CLAUDE !== '0') startWatcher();

server.listen(PORT, HOST, () => {
  console.log('\n🛰  小梦 · LAN Agent Platform');
  console.log(`   listening on ${HOST}:${server.address().port}${AUTH_TOKEN ? '  (auth: ON)' : '  (auth: off)'}`);
  console.log(`   hook intake : POST http://localhost:${PORT}/hooks/event`);
  console.log(`   REST api    : GET  http://localhost:${PORT}/api/sessions`);
  console.log(`   pair phone  : http://localhost:${server.address().port}/pair/`);
  printLanHints(PORT);
  console.log('');
});

function printLanHints(port) {
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
