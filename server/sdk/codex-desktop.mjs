import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const versions = { initialize: 0, 'thread-owner-discovery': 1, 'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1, 'thread-follower-interrupt-turn': 4,
  'thread-follower-update-thread-settings': 1, 'thread-follower-compact-thread': 1,
  'thread-follower-command-approval-decision': 1, 'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1, 'thread-follower-submit-user-input': 1,
  'thread-follower-submit-mcp-server-elicitation-response': 1 };

export function desktopTurns(state) {
  if (state?.turnHistory?.kind !== 'canonical') return state?.turns || [];
  const history = state.turnHistory.history;
  return history.islands.flatMap((island) => island.entries.map((entry) => history.entitiesByKey[entry.value]).filter(Boolean));
}

export function applyDesktopPatches(state, patches) {
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || patch.path.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Invalid desktop patch path');
    if (!['add', 'replace', 'remove'].includes(patch.op)) throw new Error('Unsupported desktop patch');
    if (!patch.path.length) { state = patch.op === 'remove' ? null : patch.value; continue; }
    let target = state;
    for (const key of patch.path.slice(0, -1)) {
      if (target == null || !Object.hasOwn(target, key)) throw new Error('Desktop patch base unavailable');
      target = target[key];
    }
    const key = patch.path.at(-1);
    if (Array.isArray(target) && patch.op === 'add') target.splice(Number(key), 0, patch.value);
    else if (Array.isArray(target) && patch.op === 'remove') target.splice(Number(key), 1);
    else if (patch.op === 'remove') delete target[key];
    else target[key] = patch.value;
  }
  return state;
}

// This versioned local IPC is implemented by the desktop app, not the public App Server.
// It follows the existing owner instead of opening a competing writer for the same thread.
export class CodexDesktop extends EventEmitter {
  constructor({ endpoint = process.env.CODEX_DESKTOP_PIPE || (process.platform === 'win32'
    ? '\\\\.\\pipe\\codex-ipc' : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock')),
    timeoutMs = 5000 } = {}) {
    super(); Object.assign(this, { endpoint, timeoutMs });
    this.pending = new Map(); this.owners = new Map(); this.states = new Map(); this.discovering = new Map();
    this.revisions = new Map(); this.buffer = Buffer.alloc(0); this.ready = false;
  }

  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const socket = net.connect(this.endpoint); this.socket = socket;
      socket.on('data', (chunk) => this.receive(chunk));
      socket.on('error', () => {});
      socket.on('close', () => { if (this.socket === socket) this.disconnected(); });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('桌面连接超时')); }, this.timeoutMs);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      const result = await this.request('initialize', { clientType: 'xiaomeng-lan' });
      if (result.resultType !== 'success' || !result.result?.clientId) { socket.destroy(); throw new Error('桌面连接初始化失败'); }
      this.clientId = result.result.clientId; this.ready = true;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  send(message) {
    if (!this.socket || this.socket.destroyed) throw new Error('Codex 桌面已断开');
    const bytes = Buffer.from(JSON.stringify(message));
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Desktop message too large');
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    this.socket.write(Buffer.concat([header, bytes]));
  }

  request(method, params, targetClientId) {
    if (!Object.hasOwn(versions, method)) return Promise.reject(new Error('Unsupported desktop operation'));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('桌面操作回执超时，请核对状态；未自动重试')); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: 'request', requestId, sourceClientId: this.clientId || 'initializing-client',
        version: versions[method], method, params, targetClientId, timeoutMs: this.timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  following(threadId, owner, following = true) {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: this.clientId, targetClientIds: [owner], params: { hostId: 'local', conversationId: threadId, following } });
  }

  async follow(threadId) {
    if (this.ready && this.owners.has(threadId)) return true;
    if (this.discovering.has(threadId)) return this.discovering.get(threadId);
    const discovery = (async () => {
      await this.connect();
      const owner = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId });
      if (owner.resultType !== 'success') return false;
      this.owners.set(threadId, owner.handledByClientId);
      this.following(threadId, owner.handledByClientId);
      return true;
    })();
    this.discovering.set(threadId, discovery);
    try { return await discovery; } finally { this.discovering.delete(threadId); }
  }

  has(threadId) { return this.ready && this.owners.has(threadId); }

  async state(threadId) {
    if (this.states.has(threadId)) return this.states.get(threadId);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('state', receive); this.off('lost', lost); };
      const receive = (id, state) => { if (id === threadId) { cleanup(); resolve(state); } };
      const lost = (id) => { if (id === threadId) { cleanup(); reject(new Error('桌面会话已断开')); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error('桌面状态同步超时，请重试')); }, this.timeoutMs);
      this.on('state', receive); this.on('lost', lost);
    });
  }

  async call(threadId, operation, params = {}) {
    if (!await this.follow(threadId)) throw new Error('桌面未持有此会话，请刷新后重试');
    const reply = await this.request(`thread-follower-${operation}`, { ...params, conversationId: threadId }, this.owners.get(threadId));
    if (reply.resultType !== 'success') {
      if (['no-client-found', 'client-disconnected'].includes(reply.error)) this.forget(threadId);
      throw new Error(reply.error || '桌面操作失败');
    }
    return reply.result;
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (!length || length > 64 * 1024 * 1024) throw new Error('Invalid desktop frame');
        if (this.buffer.length < length + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, length + 4));
        this.buffer = this.buffer.subarray(length + 4);
        this.message(message);
      }
    } catch (error) { this.emit('warning', error); this.socket?.destroy(); }
  }

  message(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.requestId); pending.resolve(message); }
      return;
    }
    if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }); return;
    }
    if (message.type !== 'broadcast') return;
    const p = message.params;
    if (message.method === 'client-status-changed' && p.status === 'disconnected') {
      for (const [id, owner] of this.owners) if (owner === p.clientId) this.forget(id);
    }
    const id = p?.conversationId;
    if (p?.hostId !== 'local' || this.owners.get(id) !== message.sourceClientId) return;
    if (message.method === 'thread-stream-following-status-requested') { this.following(id, message.sourceClientId); return; }
    if (message.method !== 'thread-stream-state-changed') return;
    if (message.version !== 11) { this.forget(id); this.emit('warning', new Error('Codex 桌面协议版本变化，需要更新适配器')); return; }
    const change = p.change;
    if (change.type === 'snapshot') this.states.set(id, change.conversationState);
    else if (change.type === 'patches') {
      if (this.revisions.get(id) !== change.baseRevision || !this.states.has(id)) {
        this.following(id, message.sourceClientId, false); this.following(id, message.sourceClientId); return;
      }
      this.states.set(id, applyDesktopPatches(this.states.get(id), change.patches));
    } else return;
    this.revisions.set(id, change.revision);
    this.emit('state', id, this.states.get(id));
  }

  forget(id) { this.owners.delete(id); this.states.delete(id); this.revisions.delete(id); this.emit('lost', id); }
  disconnected() {
    this.ready = false; this.buffer = Buffer.alloc(0);
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error('桌面连接中断，操作结果未知')); this.pending.delete(id); }
    for (const id of [...this.owners.keys()]) this.forget(id);
  }
  close() { this.socket?.destroy(); this.disconnected(); }
}
