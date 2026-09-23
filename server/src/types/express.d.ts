/** 只有 Agent 认证中间件可以写入此身份，控制器在认证后读取。 */
declare namespace Express {
  /** 扩展 Express 请求，传递前置认证中间件确认的 Agent 身份。 */
  interface Request {
    /** 通过专用接入令牌确认的中心 Agent ID。 */
    agentId?: string;
  }
}
