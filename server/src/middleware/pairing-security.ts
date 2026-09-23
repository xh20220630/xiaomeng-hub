/** 配对管理同时核对 socket、Host 与 Origin，防止 DNS 重绑定绕过本机限制。 */
import type { RequestHandler } from 'express';

/**
 * 配对页面不缓存凭据，并限制资源来源及跨页面引用。
 * @param _req 此处理器不读取的请求参数。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @param next 把控制权或错误交给后续中间件。
 * @returns 无返回值。
 */
export const pairingHeaders: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
};

/**
 * 兑换端点允许手机访问，但拒绝跨站浏览器请求。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @param next 把控制权或错误交给后续中间件。
 * @returns 无返回值。
 */
export const exchangeOriginGuard: RequestHandler = (req, res, next) => {
  if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') {
    res.status(403).json({ error: '请使用小梦 APP 扫码绑定' });
    return;
  }
  next();
};

/**
 * 管理页面只允许来自本机且 Host/Origin 一致的请求。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @param next 把控制权或错误交给后续中间件。
 * @returns 无返回值。
 */
export const localManagementGuard: RequestHandler = (req, res, next) => {
  const host = req.headers.host || '';
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  if (
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') ||
    !localHost ||
    (req.headers.origin && req.headers.origin !== `http://${host}`) ||
    req.headers['sec-fetch-site'] === 'cross-site'
  ) {
    res.status(403).type('text').send('请在宿主机上打开 http://localhost:端口/pair/ 管理绑定。');
    return;
  }
  next();
};
