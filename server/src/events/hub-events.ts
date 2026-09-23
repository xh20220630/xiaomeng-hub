/** 服务层发布领域事件，不直接依赖 WebSocket 连接，避免业务与传输循环引用。 */
import { EventEmitter } from 'node:events';

/** 进程内事件总线，传输层负责订阅并发送给在线客户端。 */
export const hubEvents = new EventEmitter();

/**
 * 发布已有客户端协议格式的事件，不改变消息字段或发送顺序。
 * @param event 需要实时推送的领域变化。
 * @returns 发布完成后返回；无订阅者时不会缓存瞬时事件。
 */
export function broadcast(event: Record<string, unknown>): void {
  hubEvents.emit('broadcast', event);
}
