/** HTTP 控制器适配Agent 注册、隔离与命令分发，业务规则由服务层负责。 */
import type { Request, Response } from 'express';
import * as agents from '../services/agent.service.js';
import { agentNotifications } from '../events/agent-events.js';
import { enrollmentGuard } from '../middleware/agent-auth.js';
/**
 * 验证注册凭据后创建稳定身份，并以 201 返回专用接入令牌。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 无返回值；结果写入 HTTP 响应。
 */
export function register(req: Request, res: Response) {
  enrollmentGuard(req);
  res.status(201).json(agents.registerAgent(req.body || {}));
}

/**
 * 使用已认证身份刷新心跳，不接受请求正文指定其他 Agent。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function heartbeat(req: Request, res: Response) {
  return res.json(agents.heartbeat(req.agentId!));
}

/**
 * 建立 SSE 命令唤醒流，在连接关闭时释放心跳及事件监听器。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 无返回值；结果写入 HTTP 响应。
 */
export function stream(req: Request, res: Response) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  /**
   * 通知 Agent 提前领取命令；具体命令仍从持久队列读取。
   * @returns 写入缓冲区是否仍可继续接收数据。
   */
  const wake = () => res.write('data: commands\n\n');
  agentNotifications.on(req.agentId!, wake);
  wake();
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 5000);
  res.on('close', () => {
    clearInterval(heartbeat);
    agentNotifications.off(req.agentId!, wake);
  });
}

/**
 * 仅更新当前已认证 Agent 的资料和能力声明。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function profile(req: Request, res: Response) {
  return res.json(agents.configureAgent(req.agentId!, req.body || {}));
}

/**
 * 上报当前 Agent 的项目及会话摘要，由服务层校验资源归属。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function session(req: Request, res: Response) {
  return res.json(agents.upsertRemoteSession(req.agentId!, req.body || {}));
}

/**
 * 上报保存项目，使尚无会话的目录也可在客户端出现。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function project(req: Request, res: Response) {
  return res.json(agents.upsertRemoteProject(req.agentId!, req.body || {}));
}

/**
 * 转交当前 Agent 的活动记录，由服务层执行归属检查和去重。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function event(req: Request, res: Response) {
  return res.json(agents.appendRemoteEvent(req.agentId!, req.body || {}));
}

/**
 * 登记当前 Agent 的主机审批，保留手机回复所需信息。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function approval(req: Request, res: Response) {
  return res.json(agents.requestRemoteApproval(req.agentId!, req.body || {}));
}

/**
 * 接收主机最终审批状态，避免手机受理回执提前结束审批。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function resolveApproval(req: Request, res: Response) {
  return res.json(agents.closeRemoteApproval(req.agentId!, req.params.id, req.body?.status));
}

/**
 * 领取当前 Agent 可执行的命令，并记录交付状态。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function commands(req: Request, res: Response) {
  return res.json(agents.takeCommands(req.agentId!));
}

/**
 * 提交当前 Agent 的执行回执，服务层校验命令归属和终态。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function commandResult(req: Request, res: Response) {
  return res.json(agents.completeCommand(req.agentId!, req.params.id, req.body || {}));
}
