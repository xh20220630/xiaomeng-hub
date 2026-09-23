/** 维护桌面 IPC 连接与版本化状态补丁，拒绝不可信路径和过期状态。 */
import type {
  DesktopState,
  DesktopTurn,
  DesktopPatch,
  DesktopReply,
  DesktopMessage,
  RpcPending,
} from '../../types/codex.js';
import { asError } from '../../utils/errors.js';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/** 桌面传输可使用系统管道或测试 TCP 端点。 */
export interface DesktopOptions {
  /** 当前用户的本机 IPC 端点。 */
  endpoint?: string | net.NetConnectOpts;
  /** 请求和状态等待的超时。 */
  timeoutMs?: number;
}

const versions: Record<string, number> = {
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-update-thread-settings': 1,
  'thread-follower-compact-thread': 1,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-user-input': 1,
  'thread-follower-submit-mcp-server-elicitation-response': 1,
};

/**
 * 兼容桌面旧版轮次数组与规范化历史索引。
 * @param state 待读取或更新的当前状态。
 * @returns 按原顺序展开的桌面轮次。
 */
export function desktopTurns(state: DesktopState | null | undefined): DesktopTurn[] {
  if (state?.turnHistory?.kind !== 'canonical') return state?.turns || [];
  const history = state.turnHistory.history;
  return history.islands.flatMap((island) =>
    island.entries.map((entry) => history.entitiesByKey[entry.value]).filter(Boolean),
  );
}

/**
 * 应用桌面补丁并拒绝原型相关路径，防止状态更新污染对象原型。
 * @param state 待读取或更新的当前状态。
 * @param patches 主机按顺序发送的状态补丁。
 * @returns 更新后的状态根对象。
 */
export function applyDesktopPatches<T>(state: T, patches: DesktopPatch[]): T {
  let result: unknown = state;
  for (const patch of patches) {
    if (
      !Array.isArray(patch.path) ||
      patch.path.some((key) => ['__proto__', 'prototype', 'constructor'].includes(String(key)))
    )
      throw new Error('Invalid desktop patch path');
    if (!['add', 'replace', 'remove'].includes(patch.op))
      throw new Error('Unsupported desktop patch');
    if (!patch.path.length) {
      result = patch.op === 'remove' ? null : patch.value;
      continue;
    }
    let target: unknown = result;
    for (const key of patch.path.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key))
        throw new Error('Desktop patch base unavailable');
      target = (target as Record<string | number, unknown>)[key];
    }
    if (!target || typeof target !== 'object') throw new Error('Desktop patch base unavailable');
    const key = patch.path.at(-1)!;
    if (Array.isArray(target) && patch.op === 'add') target.splice(Number(key), 0, patch.value);
    else if (Array.isArray(target) && patch.op === 'remove') target.splice(Number(key), 1);
    else if (patch.op === 'remove') delete (target as Record<string | number, unknown>)[key];
    else (target as Record<string | number, unknown>)[key] = patch.value;
  }
  return result as T;
}

// This versioned local IPC is implemented by the desktop app, not the public App Server.
// It follows the existing owner instead of opening a competing writer for the same thread.
/** 管理桌面 IPC 的会话状态与请求关联，并隔离不同连接的生命周期。 */
export class CodexDesktop extends EventEmitter {
  /** 桌面 IPC 管道或测试端点。 */
  endpoint!: string | net.NetConnectOpts;
  /** 等待回执的最大毫秒数。 */
  timeoutMs!: number;
  /** 按请求 ID 保存的回执等待器。 */
  pending: Map<string, RpcPending<DesktopReply>>;
  /** 会话 ID 到实际桌面拥有者的映射。 */
  owners: Map<string, string>;
  /** 桌面拥有者最近确认的完整会话状态。 */
  states: Map<string, DesktopState>;
  /** 正在进行的拥有者发现请求，用于合并并发查询。 */
  discovering: Map<string, Promise<boolean>>;
  /** 各会话已应用的最后一个状态修订号。 */
  revisions: Map<string, number>;
  /** 尚未组成完整帧的输入字节。 */
  buffer: Buffer;
  /** 初始化已完成且通道仍可使用。 */
  ready: boolean;
  /** 共享的连接建立过程，防止重复连接。 */
  connecting?: Promise<void> | null;
  /** 当前网络或 IPC 连接。 */
  socket?: net.Socket;
  /** 桌面为当前接入端分配的身份。 */
  clientId?: string;

  /**
   * 建立实例独立的依赖与状态，避免不同接入端互相覆盖。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.endpoint 请求路径或本机 IPC 端点。
   * @param options.timeoutMs 等待主机回执的最大毫秒数。
   * @returns 已初始化但尚未连接的实例。
   */
  constructor({
    endpoint = process.env.CODEX_DESKTOP_PIPE ||
      (process.platform === 'win32'
        ? '\\\\.\\pipe\\codex-ipc'
        : path.join(
            process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
            'ipc',
            'ipc.sock',
          )),
    timeoutMs = 5000,
  }: DesktopOptions = {}) {
    super();
    Object.assign(this, { endpoint, timeoutMs });
    this.pending = new Map();
    this.owners = new Map();
    this.states = new Map();
    this.discovering = new Map();
    this.revisions = new Map();
    this.buffer = Buffer.alloc(0);
    this.ready = false;
  }

  /**
   * 建立执行通道并同步必要身份，后续操作才可开始。
   * @returns 操作完成的异步信号。
   */
  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const socket =
        typeof this.endpoint === 'string' ? net.connect(this.endpoint) : net.connect(this.endpoint);
      this.socket = socket;
      socket.on('data', (chunk) => this.receive(chunk));
      socket.on('error', () => {});
      socket.on('close', () => {
        if (this.socket === socket) this.disconnected();
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('桌面连接超时'));
        }, this.timeoutMs);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const result = await this.request('initialize', { clientType: 'xiaomeng-lan' });
      if (result.resultType !== 'success' || !result.result?.clientId) {
        socket.destroy();
        throw new Error('桌面连接初始化失败');
      }
      this.clientId = result.result.clientId;
      this.ready = true;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * 只向已连接的主机通道写入协议数据。
   * @param message 协议消息或可展示的错误说明。
   * @returns 无返回值。
   */
  send(message: unknown) {
    if (!this.socket || this.socket.destroyed) throw new Error('Codex 桌面已断开');
    const bytes = Buffer.from(JSON.stringify(message));
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Desktop message too large');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    this.socket.write(Buffer.concat([header, bytes]));
  }

  /**
   * 发送有超时边界的协议请求，使用请求 ID 对齐回执。
   * @param method 主机或 HTTP 协议的方法名称。
   * @param params 与协议方法对应的参数。
   * @param targetClientId 应处理请求的桌面客户端 ID。
   * @returns 与该请求对应的主机或中心结果。
   */
  request(method: string, params: unknown, targetClientId?: string): Promise<DesktopReply> {
    if (!Object.hasOwn(versions, method))
      return Promise.reject(new Error('Unsupported desktop operation'));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('桌面操作回执超时，请核对状态；未自动重试'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({
          type: 'request',
          requestId,
          sourceClientId: this.clientId || 'initializing-client',
          version: versions[method],
          method,
          params,
          targetClientId,
          timeoutMs: this.timeoutMs,
        });
      } catch (cause) {
        const error = asError(cause);
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * 通知拥有者开始或结束跟随，便于主机控制状态推送。
   * @param threadId Codex 主机线程标识。
   * @param owner 已发现的桌面会话拥有者 ID。
   * @param following 是否开始接收目标线程的状态广播。
   * @returns 无返回值。
   */
  following(threadId: string, owner: string, following = true) {
    this.send({
      type: 'broadcast',
      method: 'thread-stream-following-changed',
      version: 1,
      sourceClientId: this.clientId,
      targetClientIds: [owner],
      params: { hostId: 'local', conversationId: threadId, following },
    });
  }

  /**
   * 发现现有会话拥有者并跟随其状态，不打开第二个写入者。
   * @param threadId Codex 主机线程标识。
   * @returns 是否已找到并跟随主机会话。
   */
  async follow(threadId: string): Promise<boolean> {
    if (this.ready && this.owners.has(threadId)) return true;
    if (this.discovering.has(threadId)) return this.discovering.get(threadId)!;
    const discovery = (async () => {
      await this.connect();
      const owner = await this.request('thread-owner-discovery', {
        hostId: 'local',
        conversationId: threadId,
      });
      if (owner.resultType !== 'success' || !owner.handledByClientId) return false;
      this.owners.set(threadId, owner.handledByClientId);
      this.following(threadId, owner.handledByClientId);
      return true;
    })();
    this.discovering.set(threadId, discovery);
    try {
      return await discovery;
    } finally {
      this.discovering.delete(threadId);
    }
  }

  /**
   * 确认桌面连接仍持有目标会话的拥有者信息。
   * @param threadId Codex 主机线程标识。
   * @returns 是否可通过桌面通道操作。
   */
  has(threadId: string) {
    return this.ready && this.owners.has(threadId);
  }

  /**
   * 读取或等待目标桌面的完整快照，避免用未同步状态执行操作。
   * @param threadId Codex 主机线程标识。
   * @returns 已同步的桌面状态；超时或失去拥有者时拒绝。
   */
  async state(threadId: string): Promise<DesktopState> {
    if (this.states.has(threadId)) return this.states.get(threadId)!;
    return new Promise((resolve, reject) => {
      /**
       * 移除等待期间的监听器和超时任务，避免重复完成回调。
       * @returns 无返回值。
       */
      const cleanup = () => {
        clearTimeout(timer);
        this.off('state', receive);
        this.off('lost', lost);
      };
      /**
       * 只用目标会话的快照完成等待，其他会话更新不影响本次请求。
       * @param id 待处理实体的稳定标识。
       * @param state 待读取或更新的当前状态。
       * @returns 无返回值。
       */
      const receive = (id: string, state: DesktopState) => {
        if (id === threadId) {
          cleanup();
          resolve(state);
        }
      };
      /**
       * 目标桌面会话失去拥有者时结束等待，避免悬挂请求。
       * @param id 待处理实体的稳定标识。
       * @returns 无返回值。
       */
      const lost = (id: string) => {
        if (id === threadId) {
          cleanup();
          reject(new Error('桌面会话已断开'));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('桌面状态同步超时，请重试'));
      }, this.timeoutMs);
      this.on('state', receive);
      this.on('lost', lost);
    });
  }

  /**
   * 只向目标会话的实际拥有者提交版本化桌面操作。
   * @param threadId Codex 主机线程标识。
   * @param operation 目标主机支持的操作名称。
   * @param params 与协议方法对应的参数。
   * @returns 桌面操作返回内容。
   */
  async call(threadId: string, operation: string, params: Record<string, unknown> = {}) {
    if (!(await this.follow(threadId))) throw new Error('桌面未持有此会话，请刷新后重试');
    const reply = await this.request(
      `thread-follower-${operation}`,
      { ...params, conversationId: threadId },
      this.owners.get(threadId),
    );
    if (reply.resultType !== 'success') {
      if (['no-client-found', 'client-disconnected'].includes(reply.error || ''))
        this.forget(threadId);
      throw new Error(reply.error || '桌面操作失败');
    }
    return reply.result;
  }

  /**
   * 解析传输帧并分派回执，错误格式会结束当前连接。
   * @param chunk 本次收到的二进制数据片段。
   * @returns 无返回值。
   */
  receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (!length || length > 64 * 1024 * 1024) throw new Error('Invalid desktop frame');
        if (this.buffer.length < length + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(length + 4);
        this.message(message);
      }
    } catch (cause) {
      const error = asError(cause);
      this.emit('warning', error);
      this.socket?.destroy();
    }
  }

  /**
   * 校验广播来源和版本，并按修订号更新桌面状态。
   * @param message 协议消息或可展示的错误说明。
   * @returns 无返回值。
   */
  message(message: DesktopMessage) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.resolve(message);
      }
      return;
    }
    if (message.type === 'client-discovery-request') {
      this.send({
        type: 'client-discovery-response',
        requestId: message.requestId,
        response: { canHandle: false },
      });
      return;
    }
    if (message.type !== 'broadcast') return;
    const p = message.params;
    if (message.method === 'client-status-changed' && p.status === 'disconnected') {
      for (const [id, owner] of this.owners) if (owner === p.clientId) this.forget(id);
    }
    const id = p?.conversationId;
    if (p?.hostId !== 'local' || this.owners.get(id) !== message.sourceClientId) return;
    if (message.method === 'thread-stream-following-status-requested') {
      this.following(id, message.sourceClientId);
      return;
    }
    if (message.method !== 'thread-stream-state-changed') return;
    if (message.version !== 11) {
      this.forget(id);
      this.emit('warning', new Error('Codex 桌面协议版本变化，需要更新适配器'));
      return;
    }
    const change = p.change;
    if (change.type === 'snapshot') this.states.set(id, change.conversationState);
    else if (change.type === 'patches') {
      if (this.revisions.get(id) !== change.baseRevision || !this.states.has(id)) {
        this.following(id, message.sourceClientId, false);
        this.following(id, message.sourceClientId);
        return;
      }
      this.states.set(id, applyDesktopPatches(this.states.get(id)!, change.patches));
    } else return;
    this.revisions.set(id, change.revision);
    this.emit('state', id, this.states.get(id));
  }

  /**
   * 移除过期的拥有者和状态缓存，并通知等待方。
   * @param id 待处理实体的稳定标识。
   * @returns 无返回值。
   */
  forget(id: string) {
    this.owners.delete(id);
    this.states.delete(id);
    this.revisions.delete(id);
    this.emit('lost', id);
  }
  /**
   * 拒绝全部挂起请求并清理会话关联，使结果未知的操作不会被重试。
   * @returns 无返回值。
   */
  disconnected() {
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('桌面连接中断，操作结果未知'));
      this.pending.delete(id);
    }
    for (const id of [...this.owners.keys()]) this.forget(id);
  }
  /**
   * 释放实例持有的连接和计时器，使停止后不再接收或发送任务。
   * @returns 无返回值。
   */
  close() {
    this.socket?.destroy();
    this.disconnected();
  }
}
