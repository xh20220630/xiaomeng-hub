/** 封装 Codex App Server 传输与请求关联，避免业务代码依赖进程管道细节。 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Interface } from 'node:readline';
import type { RpcResults, RpcPending } from '../../types/codex.js';
import { asError } from '../../utils/errors.js';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

/** 选择复用 WebSocket 或启动本机 App Server，不同时启用两个写入通道。 */
export interface CodexRpcOptions {
  /** 已有 App Server 的 WebSocket 地址。 */
  url?: string;
  /** 远端通道的认证令牌。 */
  token?: string;
  /** 可执行程序和固定前缀参数。 */
  command?: [string, string[]];
  /** 启动 App Server 的参数。 */
  args?: string[];
  /** 单个 RPC 的最大等待时间。 */
  timeoutMs?: number;
  /** 子进程环境。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 解析跨平台 Codex 可执行入口，避免用 shell 处理任意参数。
 * @param binary Codex 程序入口，可为原生可执行文件或脚本。
 * @returns 可执行程序及固定前缀参数。
 */
export function codexCommand(binary = process.env.CODEX_BIN || 'codex'): [string, string[]] {
  if (binary.endsWith('.js') || binary.endsWith('.mjs')) return [process.execPath, [binary]];
  if (process.platform !== 'win32' || binary.endsWith('.exe')) return [binary, []];
  const candidates = execFileSync('where.exe', [binary], { encoding: 'utf8', windowsHide: true })
    .trim()
    .split(/\r?\n/);
  for (const candidate of candidates) {
    if (candidate.endsWith('.exe')) return [candidate, []];
    const entry = path.join(
      path.dirname(candidate),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    if (existsSync(entry)) return [process.execPath, [entry]];
  }
  throw new Error('找不到 Codex 可执行文件；请用 CODEX_BIN 指定 codex.exe 或 bin/codex.js');
}

/** 统一管理 App Server 的 stdio 与 WebSocket 通道，使上层只依赖类型化 RPC。 */
export class CodexRpc extends EventEmitter {
  /** 目标服务或资源地址。 */
  url?: string;
  /** 此连接使用的认证凭据。 */
  token?: string;
  /** 可执行程序与固定前缀参数。 */
  command?: [string, string[]];
  /** 传给主机进程的固定参数。 */
  args!: string[];
  /** 等待回执的最大毫秒数。 */
  timeoutMs!: number;
  /** 主机子进程环境变量。 */
  env!: NodeJS.ProcessEnv;
  /** 按请求 ID 保存的回执等待器。 */
  pending: Map<string | number, RpcPending<unknown>>;
  /** 为当前连接生成不重复请求 ID 的序号。 */
  sequence: number;
  /** 初始化已完成且通道仍可使用。 */
  ready: boolean;
  /** 当前网络或 IPC 连接。 */
  socket?: WebSocket;
  /** 当前实例启动的主机子进程。 */
  child?: ChildProcessWithoutNullStreams;
  /** 子进程标准输出的逐行解析器。 */
  lines?: Interface;

  /**
   * 建立实例独立的依赖与状态，避免不同接入端互相覆盖。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.url 目标服务或资源地址。
   * @param options.token 待验证或用于认证的凭据。
   * @param options.command 待执行命令或中心命令记录。
   * @param options.args 固定命令行参数或主机动作参数。
   * @param options.timeoutMs 等待主机回执的最大毫秒数。
   * @param options.env 主机子进程环境变量。
   * @returns 已初始化但尚未连接的实例。
   */
  constructor({
    url,
    token,
    command,
    args = ['app-server'],
    timeoutMs = 30000,
    env = process.env,
  }: CodexRpcOptions = {}) {
    super();
    Object.assign(this, { url, token, command, args, timeoutMs, env });
    this.pending = new Map();
    this.sequence = 0;
    this.ready = false;
  }

  /**
   * 建立执行通道并同步必要身份，后续操作才可开始。
   * @returns 操作完成的异步信号。
   */
  async connect() {
    if (this.url) {
      const url = new URL(this.url);
      if (
        !['ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('Invalid Codex WebSocket URL');
      if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Codex ws:// 只允许本机或 SSH 本地转发；远程连接请使用 wss://');
      this.socket = new WebSocket(this.url, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        handshakeTimeout: this.timeoutMs,
        maxPayload: 64 * 1024 * 1024,
      });
      this.socket.on('message', (data) => this.receive(data.toString()));
      this.socket.on('close', () => this.disconnected(new Error('Codex connection closed')));
      this.socket.on('error', (error) => this.disconnected(error));
      await new Promise<void>((resolve, reject) => {
        this.socket!.once('open', resolve);
        this.socket!.once('error', reject);
      });
    } else {
      const [bin, prefix] = this.command || codexCommand();
      this.child = spawn(bin, [...prefix, ...this.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.env,
      });
      this.child.on('error', (error) => this.disconnected(error));
      this.child.on('exit', () => this.disconnected(new Error('Codex app-server exited')));
      this.child.stdin.on('error', (error) => this.disconnected(error));
      this.lines = createInterface({ input: this.child.stdout });
      this.lines.on('line', (line) => this.receive(line));
      this.child.stderr.on('data', () => {});
    }
    this.ready = true;
    await this.request('initialize', {
      clientInfo: { name: 'xiaomeng_lan', title: '小梦 Agent 平台', version: '1.3.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
  }

  /**
   * 解析传输帧并分派回执，错误格式会结束当前连接。
   * @param line 一行完整 JSON 协议文本。
   * @returns 无返回值。
   */
  receive(line: string) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.disconnected(new Error('Invalid Codex JSON-RPC message'));
      return;
    }
    if (message.method) {
      this.emit(message.id == null ? 'notification' : 'request', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else pending.resolve(message.result);
  }

  /**
   * 只向已连接的主机通道写入协议数据。
   * @param message 协议消息或可展示的错误说明。
   * @returns 无返回值。
   */
  send(message: unknown) {
    if (!this.ready) throw new Error('Codex 未连接');
    const data = JSON.stringify(message);
    if (this.socket) this.socket.send(data);
    else this.child!.stdin.write(`${data}\n`);
  }

  /**
   * 发送有超时边界的协议请求，使用请求 ID 对齐回执。
   * @param method 主机或 HTTP 协议的方法名称。
   * @param params 与协议方法对应的参数。
   * @returns 与该请求对应的主机或中心结果。
   */
  request<K extends keyof RpcResults>(method: K, params: unknown = {}): Promise<RpcResults[K]> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 超时，结果未知；请刷新任务状态`));
      }, this.timeoutMs);
      this.pending.set(id, {
        /**
         * 将回执交给对应方法的等待方，结果类型与 RPC 方法名保持关联。
         * @param result 主机返回的操作结果。
         * @returns 无返回值。
         */
        resolve: (result) => resolve(result as RpcResults[K]),
        reject,
        timer,
      });
      try {
        this.send({ id, method, params });
      } catch (cause) {
        const error = asError(cause);
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * 回复主机发起的 JSON-RPC 请求，保留原请求 ID 以关联审批结果。
   * @param id 待处理实体的稳定标识。
   * @param result 当前主机或存储操作的结果。
   * @returns 无返回值。
   */
  respond(id: string | number, result: unknown) {
    this.send({ id, result });
  }
  /**
   * 明确拒绝当前不支持的主机请求，避免请求无限等待。
   * @param id 待处理实体的稳定标识。
   * @param message 协议消息或可展示的错误说明。
   * @returns 无返回值。
   */
  reject(id: string | number, message = 'Unsupported client request') {
    this.send({ id, error: { code: -32601, message } });
  }

  /**
   * 拒绝全部挂起请求并清理会话关联，使结果未知的操作不会被重试。
   * @param error 需要记录或交给等待方的错误。
   * @returns 无返回值。
   */
  disconnected(error: Error) {
    const wasReady = this.ready;
    this.ready = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (wasReady) this.emit('disconnect', error);
  }

  /**
   * 释放实例持有的连接和计时器，使停止后不再接收或发送任务。
   * @returns 操作完成的异步信号。
   */
  async close() {
    this.disconnected(new Error('Codex adapter closed'));
    this.socket?.close();
    if (this.socket) {
      const socket = this.socket;
      const timer = setTimeout(() => socket.terminate(), 1000);
      socket.once('close', () => clearTimeout(timer));
    }
    if (this.child?.pid && this.child.exitCode === null) {
      this.child.stdin.end();
      const killer = setTimeout(() => this.child!.kill(), 3000);
      await new Promise((resolve) => this.child!.once('exit', resolve));
      clearTimeout(killer);
    }
    this.lines?.close();
  }
}
