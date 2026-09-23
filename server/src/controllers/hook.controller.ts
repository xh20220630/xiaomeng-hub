/** hook 通知先应答以免拖慢 CLI，gate 则等待服务层给出审批决定。 */
import type { Request, Response } from 'express';
import { noteHook, gateHook } from '../services/hook.service.js';

/**
 * 先确认收到 hook 再更新状态，避免监控处理延迟阻塞 CLI。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 无返回值；结果写入 HTTP 响应。
 */
export function event(req: Request, res: Response): void {
  res.status(200).json({});
  if (req.body) noteHook(req.body);
}

/**
 * 等待服务层的审批决定后应答，使 CLI 获得明确的允许或拒绝结果。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 响应写入后的完成信号。
 */
export async function gate(req: Request, res: Response): Promise<void> {
  res.status(200).json(await gateHook(req.body || {}));
}
