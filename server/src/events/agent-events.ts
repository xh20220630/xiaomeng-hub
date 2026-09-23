/** Agent 命令唤醒信号只用于减少轮询延迟，持久命令仍以数据库为准。 */
import { EventEmitter } from 'node:events';

export const agentNotifications = new EventEmitter();
agentNotifications.setMaxListeners(0);
