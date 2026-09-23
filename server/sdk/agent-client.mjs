import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class AgentClient {
  constructor({ hubUrl, enrollmentToken, nodeId = os.hostname(), nodeName = os.hostname(),
    agentKey, name, provider = 'custom', handlers = {}, stateFile, onError = console.error, isAvailable = () => true }) {
    const url = new URL(hubUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid hub URL');
    this.hubUrl = url.origin;
    this.enrollmentToken = enrollmentToken;
    this.profile = { nodeId, nodeName, agentKey, name, provider, capabilities: Object.keys(handlers) };
    this.handlers = handlers;
    this.onError = onError;
    this.isAvailable = isAvailable;
    const key = createHash('sha256').update(`${this.hubUrl}\0${nodeId}\0${agentKey}`).digest('hex').slice(0, 24);
    this.stateFile = stateFile || path.join(os.homedir(), '.xiaomeng', 'agents', `${key}.json`);
    this.closed = true;
    this.receipts = new Map();
    this.active = new Set();
  }

  async request(endpoint, body, token = this.credentials?.token) {
    const response = await fetch(`${this.hubUrl}/agent${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || `HTTP ${response.status}`), { status: response.status });
    return result;
  }

  async connect() {
    if (!this.closed) return;
    try {
      this.credentials = JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.credentials = await this.request('/register', this.profile, this.enrollmentToken);
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      await writeFile(this.stateFile, JSON.stringify(this.credentials), { mode: 0o600, flag: 'wx' });
    }
    await this.request('/profile', this.profile);
    this.closed = false;
    this.streamLoop = this.listenCommands();
    this.loop = this.poll();
  }

  notifyCommands() { this.commandPending = true; this.wake?.(); }

  async listenCommands() {
    while (!this.closed) {
      this.streamAbort = new AbortController();
      try {
        const response = await fetch(`${this.hubUrl}/agent/stream`, { headers: { Authorization: `Bearer ${this.credentials.token}` }, signal: this.streamAbort.signal, redirect: 'error' });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;
        this.streamConnected = true;
        const decoder = new TextDecoder(); let buffer = '';
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (event.includes('data: commands')) this.notifyCommands();
          }
          if (buffer.length > 65536) throw new Error('Invalid command stream');
        }
      } catch (error) { if (!this.closed && error.name !== 'AbortError') this.onError(error); }
      finally { this.streamConnected = false; }
      if (!this.closed) await new Promise((resolve) => { this.streamWake = resolve; this.streamTimer = setTimeout(resolve, 1500); });
    }
  }

  async poll() {
    while (!this.closed) {
      this.commandPending = false;
      try {
        if (!this.isAvailable()) {
          await new Promise((resolve) => { this.wake = resolve; this.timer = setTimeout(resolve, 1000); });
          continue;
        }
        for (const [id, receipt] of this.receipts) {
          await this.request(`/commands/${id}/result`, receipt);
          this.receipts.delete(id);
        }
        const commands = await this.request('/commands');
        for (const command of commands) {
          const run = this.execute(command);
          this.active.add(run);
          run.finally(() => this.active.delete(run));
        }
      } catch (error) { this.onError(error); }
      if (!this.commandPending && !this.closed) await new Promise((resolve) => {
        this.wake = () => { clearTimeout(this.timer); resolve(); };
        this.timer = setTimeout(resolve, Math.min(this.streamConnected ? 5000 : 1000, this.credentials.heartbeatIntervalMs || 1000));
      });
    }
  }

  async execute(command) {
    let receipt;
    try {
      if (command.expiresAt <= Date.now()) throw new Error('Command expired before execution');
      const handler = this.handlers[command.type];
      if (!handler) throw new Error(`Unsupported operation: ${command.type}`);
      const result = await handler(command.payload, command);
      receipt = { ok: true, result: result ?? null };
    } catch (error) { receipt = { ok: false, error: String(error.message).slice(0, 2000) }; }
    this.receipts.set(command.commandId, receipt);
    try {
      await this.request(`/commands/${command.commandId}/result`, receipt);
      this.receipts.delete(command.commandId);
    } catch (error) { this.onError(error); }
  }

  session(project, session) { return this.request('/sessions', { project, session }); }
  project(project) { return this.request('/projects', project); }
  event(sessionId, type, fields = {}) {
    return this.request('/events', { eventId: randomUUID(), ...fields, sessionId, type });
  }
  approval(fields) { return this.request('/approvals', fields); }
  resolveApproval(id, status = 'expired') { return this.request(`/approvals/${encodeURIComponent(id)}/resolve`, { status }); }

  async close() {
    this.closed = true;
    this.streamAbort?.abort();
    clearTimeout(this.streamTimer); this.streamWake?.();
    clearTimeout(this.timer);
    this.wake?.();
    await this.loop;
    await this.streamLoop;
    await Promise.allSettled([...this.active]);
  }
}
