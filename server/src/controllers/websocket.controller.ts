/** WebSocket 与 HTTP 共用操作服务，接收成功回执不代表主机已执行完成。 */
import type WebSocket from 'ws';
import { asError } from '../utils/errors.js';
import * as operations from '../services/operation.service.js';
import type { CommandPayload } from '../types/domain.js';

/** 手机发出的操作帧，字段是否必需由具体操作决定。 */
export interface ClientMessage extends CommandPayload {
  /** 操作类型。 */
  type: string;
  /** 客户端生成的幂等键。 */
  requestId?: string;
  /** 会话控制动作，目前支持 stop。 */
  action?: string;
}

/**
 * 将 WebSocket 操作交给共享服务，并把失败回传给请求方。
 * @param msg 客户端发出的操作帧。
 * @param socket 当前客户端或主机连接。
 * @returns 操作完成的异步信号。
 */
export async function onClientMessage(msg: ClientMessage, socket: WebSocket) {
  try {
    let result;
    switch (msg?.type) {
      case 'approval.respond':
        console.log(
          `[ws] approval.respond ${String(msg.approvalId || '').slice(0, 8)} ${msg.decision}/${msg.scope || 'once'}`,
        );
        result = operations.resolveApproval(
          msg.approvalId || '',
          msg.decision || '',
          msg.scope || 'once',
          msg.answers,
        );
        break;
      case 'message.send':
        console.log(
          `[ws] message.send ${String(msg.sessionId || '').slice(0, 8)} len=${String(msg.text || '').length}`,
        );
        result = await operations.sendMessage(msg.sessionId || '', msg.text || '', msg.requestId);
        break;
      case 'session.control':
        console.log(
          `[ws] session.control ${String(msg.sessionId || '').slice(0, 8)} -> ${msg.action}`,
        );
        result = await operations.controlSession(
          msg.sessionId || '',
          msg.action || '',
          msg.requestId,
        );
        break;
      case 'message.steer':
        result = operations.steerMessage(msg.sessionId || '', msg.text || '', msg.requestId);
        break;
      default:
        throw new Error('Unsupported operation');
    }
    if (socket.readyState === 1)
      socket.send(
        JSON.stringify({ type: 'command.accepted', requestId: msg.requestId, ...result }),
      );
  } catch (cause) {
    const error = asError(cause);
    if (socket.readyState !== 1) return;
    socket.send(
      JSON.stringify({
        type: 'command.error',
        operation: msg?.type,
        sessionId: msg?.sessionId,
        approvalId: msg?.approvalId,
        error: error.message,
      }),
    );
    if (msg?.type === 'message.send')
      socket.send(
        JSON.stringify({
          type: 'assistant.done',
          sessionId: msg.sessionId || '',
          ok: false,
          error: error.message,
        }),
      );
  }
}
