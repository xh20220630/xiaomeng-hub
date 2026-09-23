import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

export function codexCommand(binary = process.env.CODEX_BIN || 'codex') {
  if (binary.endsWith('.js') || binary.endsWith('.mjs')) return [process.execPath, [binary]];
  if (process.platform !== 'win32' || binary.endsWith('.exe')) return [binary, []];
  const candidates = execFileSync('where.exe', [binary], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  for (const candidate of candidates) {
    if (candidate.endsWith('.exe')) return [candidate, []];
    const entry = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(entry)) return [process.execPath, [entry]];
  }
  throw new Error('找不到 Codex 可执行文件；请用 CODEX_BIN 指定 codex.exe 或 bin/codex.js');
}

export class CodexRpc extends EventEmitter {
  constructor({ url, token, command, args = ['app-server'], timeoutMs = 30000, env = process.env } = {}) {
    super();
    Object.assign(this, { url, token, command, args, timeoutMs, env });
    this.pending = new Map();
    this.sequence = 0;
    this.ready = false;
  }

  async connect() {
    if (this.url) {
      const url = new URL(this.url);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Codex WebSocket URL');
      if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Codex ws:// 只允许本机或 SSH 本地转发；远程连接请使用 wss://');
      this.socket = new WebSocket(this.url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}, handshakeTimeout: this.timeoutMs, maxPayload: 64 * 1024 * 1024 });
      this.socket.on('message', (data) => this.receive(data.toString()));
      this.socket.on('close', () => this.disconnected(new Error('Codex connection closed')));
      this.socket.on('error', (error) => this.disconnected(error));
      await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    } else {
      const [bin, prefix] = this.command || codexCommand();
      this.child = spawn(bin, [...prefix, ...this.args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env });
      this.child.on('error', (error) => this.disconnected(error));
      this.child.on('exit', () => this.disconnected(new Error('Codex app-server exited')));
      this.child.stdin.on('error', (error) => this.disconnected(error));
      this.lines = createInterface({ input: this.child.stdout });
      this.lines.on('line', (line) => this.receive(line));
      this.child.stderr.on('data', () => {});
    }
    this.ready = true;
    await this.request('initialize', { clientInfo: { name: 'xiaomeng_lan', title: '小梦 Agent 平台', version: '1.3.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.disconnected(new Error('Invalid Codex JSON-RPC message')); return; }
    if (message.method) {
      this.emit(message.id == null ? 'notification' : 'request', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else pending.resolve(message.result);
  }

  send(message) {
    if (!this.ready) throw new Error('Codex 未连接');
    const data = JSON.stringify(message);
    if (this.socket) this.socket.send(data);
    else this.child.stdin.write(`${data}\n`);
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 超时，结果未知；请刷新任务状态`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id, result) { this.send({ id, result }); }
  reject(id, message = 'Unsupported client request') { this.send({ id, error: { code: -32601, message } }); }

  disconnected(error) {
    const wasReady = this.ready;
    this.ready = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (wasReady) this.emit('disconnect', error);
  }

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
      const killer = setTimeout(() => this.child.kill(), 3000);
      await new Promise((resolve) => this.child.once('exit', resolve));
      clearTimeout(killer);
    }
    this.lines?.close();
  }
}
