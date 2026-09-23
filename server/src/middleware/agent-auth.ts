/** 注册凭据与已注册 Agent 凭据分开校验，手机设备令牌不能冒充 Agent。 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import * as agents from '../services/agent.service.js';

/**
 * 读取接入端的 Bearer 凭据。
 * @param req 当前 HTTP 请求。
 * @returns 未提供时返回空字符串。
 */
export function tokenFrom(req: Request): string {
  return String(req.headers.authorization || '').replace(/^Bearer /, '');
}

/**
 * 注册要求中心已启用认证，并对等长令牌使用恒定时间比较。
 * @param req 包含注册令牌的请求。
 * @returns 校验成功返回；失败抛出 HTTP 业务错误。
 */
export function enrollmentGuard(req: Request): void {
  const expected = process.env.AGENT_TOKEN || process.env.AUTH_TOKEN || '';
  if (!process.env.AUTH_TOKEN) agents.fail(503, 'Set AUTH_TOKEN before enrolling LAN agents');
  const a = Buffer.from(expected),
    b = Buffer.from(tokenFrom(req));
  if (a.length !== b.length || !timingSafeEqual(a, b)) agents.fail(401, 'Invalid enrollment token');
}

/**
 * 认证成功才更新心跳，拒绝未知令牌延长任何 Agent 的在线状态。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param _res 此处理器不写入的响应参数。
 * @param next 把控制权或错误交给后续中间件。
 * @returns 无返回值。
 */
export const authenticateAgent: RequestHandler = (req, _res, next) => {
  try {
    req.agentId = agents.authenticateAgent(tokenFrom(req));
    agents.heartbeat(req.agentId);
    next();
  } catch (error) {
    next(error);
  }
};
