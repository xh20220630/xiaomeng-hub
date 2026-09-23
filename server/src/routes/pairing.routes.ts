/** 公开兑换端点先注册，本机管理端点随后受统一安全中间件保护。 */
import { Router, json, static as serveStatic } from 'express';
import { createPairingService } from '../services/pairing.service.js';
import { createPairingController } from '../controllers/pairing.controller.js';
import {
  pairingHeaders,
  exchangeOriginGuard,
  localManagementGuard,
} from '../middleware/pairing-security.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { PAIR_PUBLIC_DIR } from '../config/paths.js';
import type { PairingOptions } from '../types/pairing.js';

/**
 * 为一个中心实例创建独立的二维码会话与设备认证入口。
 * @param options 数据库、管理员凭据与主机网络依赖。
 * @returns 路由以及供 REST/WebSocket 共用的设备认证函数。
 */
export function createPairing(options: PairingOptions) {
  const service = createPairingService(options);
  const controller = createPairingController(service);
  const router = Router();
  router.use(pairingHeaders, json({ limit: '8kb' }));
  router.post('/exchange', exchangeOriginGuard, asyncHandler(controller.exchange));
  router.use(localManagementGuard);
  router.get('/info', asyncHandler(controller.info));
  router.post('/sessions', asyncHandler(controller.createSession));
  router.get('/sessions/:id', asyncHandler(controller.sessionStatus));
  router.delete('/devices/:id', asyncHandler(controller.revoke));
  router.use(serveStatic(PAIR_PUBLIC_DIR));
  return { router, authorizeDevice: service.authorizeDevice };
}
