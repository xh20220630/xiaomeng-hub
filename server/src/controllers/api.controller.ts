/** HTTP 控制器适配客户端查询和操作，业务规则由服务层负责。 */
import { optionalQuery } from '../middleware/http.js';
import type { Request, Response } from 'express';
import { buildProjects } from '../services/snapshot.service.js';
import { commandInfo as readCommandInfo } from '../services/agent.service.js';
import { allAgents } from '../services/agent-directory.service.js';
import * as operations from '../services/operation.service.js';

/**
 * 返回统一 Agent 目录，使客户端同时看到本机与远程执行端。
 * @param _req 此处理器不读取的请求参数。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function listAgents(_req: Request, res: Response) {
  return res.json(allAgents());
}

/**
 * 读取主机公开的模型与能力目录，并校验可选会话查询参数。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export async function agentCatalog(req: Request, res: Response) {
  return res.json(await operations.agentCatalog(req.params.id, optionalQuery(req.query.sessionId)));
}

/**
 * 转交主机公开操作，保留请求 ID 以关联异步回执。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export async function agentAction(req: Request, res: Response) {
  return res.json(
    await operations.agentAction(
      req.params.id,
      req.body?.sessionId,
      req.body?.name,
      req.body?.arguments,
      req.body?.requestId,
    ),
  );
}

/**
 * 受理下一轮执行设置，具体能力与忙碌状态由服务层校验。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export async function configureSession(req: Request, res: Response) {
  return res.json(
    await operations.configureSession(req.params.id, req.body?.settings, req.body?.requestId),
  );
}

/**
 * 受理上下文压缩请求，以主机回执确认最终结果。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export async function compactSession(req: Request, res: Response) {
  return res.json(await operations.compactSession(req.params.id, req.body?.requestId));
}

/**
 * 返回合并本机记录、远程项目和实时状态的项目快照。
 * @param _req 此处理器不读取的请求参数。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export async function listProjects(_req: Request, res: Response) {
  return res.json(await buildProjects());
}

/**
 * 按项目标识查询会话，归属与目录校验交由服务层统一执行。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export async function projectSessions(req: Request, res: Response) {
  return res.json(await operations.projectSessions(req.params.id));
}

/**
 * 以 202 返回新建任务的受理结果，避免把受理误当作执行完成。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 响应写入后的完成信号。
 */
export async function createSession(req: Request, res: Response) {
  res
    .status(202)
    .json(await operations.createSession(req.params.id, req.body?.text, req.body?.requestId));
}

/**
 * 从统一项目快照展开会话，保持旧版列表接口兼容。
 * @param _req 此处理器不读取的请求参数。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 响应写入后的完成信号。
 */
export async function listSessions(_req: Request, res: Response) {
  const projects = await buildProjects();
  res.json(projects.flatMap((project) => project.sessions ?? []));
}

/**
 * 返回兼容旧版客户端的会话活动列表。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export async function sessionEvents(req: Request, res: Response) {
  return res.json(await operations.sessionEvents(req.params.id));
}

/**
 * 先限制分页大小及游标形状，再读取指定来源的历史页。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export async function sessionHistory(req: Request, res: Response) {
  const limit = req.query.limit == null ? 40 : Number(req.query.limit);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (req.query.cursor != null &&
      (typeof req.query.cursor !== 'string' || req.query.cursor.length > 4096))
  ) {
    return res.status(400).json({ error: 'Invalid history pagination' });
  }
  res.json(await operations.sessionHistory(req.params.id, req.query.cursor, limit));
}

/**
 * 以 202 返回消息受理信息，后续执行状态由实时事件和回执更新。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 响应写入后的完成信号。
 */
export async function sendMessage(req: Request, res: Response) {
  res
    .status(202)
    .json(await operations.sendMessage(req.params.id, req.body?.text, req.body?.requestId));
}

/**
 * 受理停止等控制命令，保留请求 ID 供客户端查询结果。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 响应写入后的完成信号。
 */
export async function controlSession(req: Request, res: Response) {
  res
    .status(202)
    .json(await operations.controlSession(req.params.id, req.body?.action, req.body?.requestId));
}

/**
 * 受理运行中追加指令，执行通道是否支持由服务层判断。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 无返回值；结果写入 HTTP 响应。
 */
export function steerMessage(req: Request, res: Response) {
  res.status(202).json(operations.steerMessage(req.params.id, req.body?.text, req.body?.requestId));
}

/**
 * 返回当前仍可决策的审批，过期及归属规则由服务层处理。
 * @param _req 此处理器不读取的请求参数。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function pendingApprovals(_req: Request, res: Response) {
  return res.json(operations.pendingApprovals());
}

/**
 * 转交审批决定和问答回复，由服务层选择本机或远程确认流程。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 无返回值；结果写入 HTTP 响应。
 */
export function resolveApproval(req: Request, res: Response) {
  res.json(
    operations.resolveApproval(
      req.params.id,
      req.body?.decision,
      req.body?.scope,
      req.body?.answers,
    ),
  );
}

/**
 * 提供按命令 ID 查询回执的入口，供客户端确认异步操作结果。
 * @param req 当前 HTTP 请求，身份由前置中间件确认。
 * @param res 当前 HTTP 响应，用于返回状态码和协议正文。
 * @returns 已发送的 HTTP 响应对象。
 */
export function commandInfo(req: Request, res: Response) {
  return res.json(readCommandInfo(req.params.id));
}
