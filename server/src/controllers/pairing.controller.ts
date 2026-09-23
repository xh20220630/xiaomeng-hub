/** 将 HTTP 参数适配为配对服务调用，保留设备兑换的状态码与错误正文。 */
import type { Request, Response } from 'express';
import type { PairingService } from '../services/pairing.service.js';

/**
 * 只适配 HTTP 输入输出，绑定状态由注入的服务维护。
 * @param service 注入的配对业务服务。
 * @returns 配对接口控制器集合。
 */
export function createPairingController(service: PairingService) {
  /**
   * 筛选当前监听地址可用的本机 IPv4 网卡。
   * @param req 当前 HTTP 请求，身份由前置中间件确认。
   * @returns 可供手机连接的候选地址。
   */
  function addresses(req: Request) {
    return service.addresses(req.socket.localAddress, req.socket.localPort);
  }
  /**
   * 将设备兑换结果及状态码原样返回，保留过期、冲突和升级提示。
   * @param req 当前 HTTP 请求，身份由前置中间件确认。
   * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
   * @returns 无返回值；结果写入 HTTP 响应。
   */
  function exchange(req: Request, res: Response) {
    const result = service.exchange(req.body || {});
    res.status(result.status).json(result.body);
  }
  /**
   * 用当前 socket 筛选可连接网卡，并返回宿主机及已绑定设备摘要。
   * @param req 当前 HTTP 请求，身份由前置中间件确认。
   * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
   * @returns 无返回值；结果写入 HTTP 响应。
   */
  function info(req: Request, res: Response) {
    res.json(service.info(addresses(req)));
  }
  /**
   * 只提交本次监听地址允许的候选网卡，生成短时配对二维码。
   * @param req 当前 HTTP 请求，身份由前置中间件确认。
   * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
   * @returns 响应写入后的完成信号。
   */
  async function createSession(req: Request, res: Response) {
    const result = await service.createSession(req.body?.serverUrl, addresses(req));
    res.status(result.status).json(result.body);
  }
  /**
   * 查询二维码是否已兑换，供管理页更新绑定状态。
   * @param req 当前 HTTP 请求，身份由前置中间件确认。
   * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
   * @returns 无返回值；结果写入 HTTP 响应。
   */
  function sessionStatus(req: Request, res: Response) {
    res.json(service.sessionStatus(req.params.id));
  }
  /**
   * 撤销选定设备并触发连接重新认证，成功后返回确认。
   * @param req 当前 HTTP 请求，身份由前置中间件确认。
   * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
   * @returns 无返回值；结果写入 HTTP 响应。
   */
  function revoke(req: Request, res: Response) {
    service.revoke(req.params.id);
    res.json({ ok: true });
  }
  return { exchange, info, createSession, sessionStatus, revoke };
}
