/** 装配 HTTP 中间件和路由；监听端口、计时器和进程退出由入口负责。 */
import express from 'express';
import db from './infrastructure/database.js';
import { AUTH_TOKEN } from './config/env.js';
import { createPairing } from './routes/pairing.routes.js';
import hooksRouter from './routes/hook.routes.js';
import apiRouter from './routes/api.routes.js';
import agentRouter from './routes/agent.routes.js';
import { allAgents } from './services/agent-directory.service.js';
import { disconnectUnauthorizedClients } from './transport/websocket.js';
import { requestToken, isLoopback, errorHandler } from './middleware/http.js';

/**
 * 装配认证与接口路由，使进程生命周期与 HTTP 行为可以独立维护。
 * @returns HTTP 应用及共享令牌校验函数。
 */
export function createApp() {
  const app = express();
  const pairing = createPairing({
    db,
    authToken: AUTH_TOKEN,
    /**
     * 设备撤销后立即重新认证已有连接，避免失效凭据继续接收事件。
     * @returns 无返回值。
     */
    onRevoke: () => disconnectUnauthorizedClients(isAuthorized),
    getAgents: allAgents,
  });
  /**
   * 同时接受管理员和有效设备令牌，设备撤销后立即失效。
   * @param token 待验证或用于认证的凭据。
   * @returns 当前令牌是否仍可访问中心服务。
   */
  function isAuthorized(token: string) {
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
  app.use(errorHandler);

  return { app, isAuthorized };
}
