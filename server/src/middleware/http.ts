/** HTTP 通用边界：读取凭据、校验本机来源并统一错误响应。 */
import type { ErrorRequestHandler, Request } from 'express';
import { asError } from '../utils/errors.js';

/**
 * 优先使用 Bearer，同时兼容现有客户端的查询参数令牌。
 * @param req 当前请求。
 * @returns 可供认证服务比较的令牌。
 */
export function requestToken(req: Request): string {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7);
  return typeof req.query.token === 'string' ? req.query.token : '';
}

/**
 * 使用实际 socket 地址判断本机来源，不信任代理头。
 * @param req 当前请求。
 * @returns 是否来自 loopback。
 */
export function isLoopback(req: Request): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
}

/**
 * 内部错误只记录在主机日志，HTTP 响应不暴露堆栈。
 * @param cause 捕获到的未知异常。
 * @param _req 此处理器不读取的请求参数。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @param _next 保留 Express 错误中间件签名的位置参数。
 * @returns 无返回值。
 */
export const errorHandler: ErrorRequestHandler = (cause: unknown, _req, res, _next) => {
  const error = asError(cause);
  const status = error.status || 500;
  if (status >= 500) console.error('[request]', error.message);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
};

/**
 * 查询参数可能为数组或嵌套对象，控制器只接受单个文本值。
 * @param value Express 解析后的参数。
 * @returns 缺省值或经过形状校验的文本。
 */
export function optionalQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw Object.assign(new Error('Invalid query parameter'), { status: 400 });
  return value;
}
