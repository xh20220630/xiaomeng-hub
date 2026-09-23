/** 监听配置在进程启动时读取一次，避免同一实例出现互相矛盾的认证状态。 */
/** 监听端口；0 保留给集成测试分配临时端口。 */
export const PORT = parseInt(process.env.PORT || '4820', 10);
/** 默认允许同一局域网手机连接。 */
export const HOST = process.env.HOST || '0.0.0.0';
/** 中心管理员令牌；远程 Agent 注册要求非空。 */
export const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
