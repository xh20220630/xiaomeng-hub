import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCodexHostIndex } from './codex-host-index.mjs';
import { historyEvent, toolResult } from './codex-history.mjs';
import { CodexDesktopBridge } from './codex-desktop-bridge.mjs';

const clipped = (value, max = 64000) => String(value ?? '').slice(0, max);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const controlCaps = ['message.send', 'message.steer', 'session.stop', 'approval.respond', 'session.configure', 'session.compact'];
const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

export class CodexAgent {
  constructor({ rpc, client, projects, stateFile, desktop, pollMs = 5000, maxThreads = Infinity, hostScope = false, lazyHistory = false, hostIndex = readCodexHostIndex, approvalTtlMs = 600000, onError = console.error }) {
    Object.assign(this, { rpc, client, stateFile, pollMs, maxThreads, hostScope, lazyHistory, hostIndex, approvalTtlMs, onError });
    this.projectAssignments = new Map();
    this.published = new Map();
    this.projects = new Map(projects.map((cwd) => {
      const root = path.resolve(cwd);
      return [root, { id: root, cwd: root, name: path.basename(root) || root }];
    }));
    this.threads = new Map();
    this.aliases = {};
    this.attached = new Set();
    this.blocked = new Map();
    this.blockedUntil = new Map();
    this.requests = new Map();
    this.items = new Map();
    this.activeTurns = new Map();
    this.streams = new Map();
    this.toolStreams = new Map();
    this.sentEvents = new Set();
    this.serial = Promise.resolve();
    this.aliasWrite = Promise.resolve();
    this.sessionLocks = new Map();
    this.instance = randomUUID();
    this.closed = false;
    this.ready = false;
    this.desktop = desktop ? new CodexDesktopBridge(this, desktop) : null;
    const available = client.isAvailable;
    client.isAvailable = () => this.ready && available();
    this.handlers = {
      'session.start': (p) => this.exclusive(p.sessionId, () => this.startSession(p)),
      'message.send': (p) => this.exclusive(p.sessionId, () => this.sendMessage(p)),
      'message.steer': (p) => this.exclusive(p.sessionId, () => this.steer(p)),
      'session.stop': (p) => this.stop(p),
      'approval.respond': (p) => this.answer(p),
      'history.read': (p) => this.readHistory(p),
      'agent.catalog': (p) => this.catalog(p),
      'session.configure': (p) => this.exclusive(p.sessionId, () => this.configure(p)),
      'session.compact': (p) => this.compact(p),
      'agent.action': (p) => this.action(p),
    };
    rpc.on('notification', (message) => this.enqueue(() => this.notification(message)));
    rpc.on('request', (message) => this.enqueue(() => this.serverRequest(message)));
    rpc.on('disconnect', () => {
      for (const request of this.requests.values()) {
        clearTimeout(request.timer);
        request.confirm?.reject(new Error('Codex 已断开，回复结果未知'));
      }
      this.requests.clear();
    });
  }

  enqueue(work) {
    const result = this.serial.then(work);
    this.serial = result.catch(this.onError);
    return result;
  }

  async exclusive(key, work) {
    if (this.sessionLocks.has(key)) throw new Error('此任务已有操作正在提交，请稍后重试');
    this.sessionLocks.set(key, true);
    try { return await work(); } finally { this.sessionLocks.delete(key); }
  }

  async connect() {
    try { this.aliases = JSON.parse(await readFile(this.stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.rpc.connect();
    await this.client.connect();
    for (const project of this.projects.values()) await this.client.project(project);
    await this.sync();
    this.ready = true;
    this.schedule();
  }

  schedule() {
    if (this.closed || !this.rpc.ready) return;
    this.timer = setTimeout(async () => {
      await this.sync().catch(this.onError);
      this.schedule();
    }, this.pollMs);
  }

  async saveAliases() {
    const write = this.aliasWrite.then(async () => {
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      const temporary = `${this.stateFile}.tmp`;
      await writeFile(temporary, JSON.stringify(this.aliases), { mode: 0o600 });
      await rename(temporary, this.stateFile);
    });
    this.aliasWrite = write.catch(() => {});
    await write;
  }

  projectFor(thread) {
    const assigned = this.projectAssignments.get(thread.projectId);
    if (assigned) return assigned;
    const root = path.resolve(thread.cwd || '');
    const normalize = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
    let project = [...this.projects.values()].find((p) => normalize(p.cwd) === normalize(root));
    if (!project && this.hostScope && thread.cwd) {
      project = { id: root, cwd: root, name: path.basename(root) || root };
      this.projects.set(root, project);
    }
    return project;
  }

  sessionId(threadId) { return this.aliases[threadId] || threadId; }
  threadFor(sessionId) {
    const thread = [...this.threads.values()].find((t) => this.sessionId(t.id) === sessionId);
    if (!thread || !this.projectFor(thread)) throw new Error('任务不存在或不在 CODEX_PROJECTS 中');
    return thread;
  }

  state(thread) {
    const last = thread.turns?.at(-1);
    const lastStatus = last?.status || thread.lastTurnStatus;
    if (this.activeTurns.has(thread.id) || thread.status?.type === 'active' || lastStatus === 'inProgress') return 'running';
    if (thread.status?.type === 'systemError' || lastStatus === 'failed') return 'error';
    if (lastStatus === 'interrupted') return 'paused';
    return lastStatus === 'completed' ? 'done' : !lastStatus && thread.status?.type === 'notLoaded' ? 'ended' : 'waiting_input';
  }

  async publish(thread) {
    const project = this.projectFor(thread);
    if (!project) return;
    const active = this.state(thread) === 'running';
    if ((this.blockedUntil.get(thread.id) || Infinity) < Date.now()) this.blocked.delete(thread.id);
    const desktop = this.desktop?.has(thread.id);
    const controlled = desktop || this.attached.has(thread.id) && thread.canAcceptDirectInput !== false;
    const unavailable = thread.archived || (!desktop && (thread.canAcceptDirectInput === false || this.blocked.has(thread.id) || (active && !controlled)));
    const caps = unavailable ? [] : controlled ? controlCaps : ['message.send', 'session.configure', 'session.compact'];
    const session = {
      id: this.sessionId(thread.id), summary: clipped(thread.name || thread.preview || 'Codex 新任务', 1000),
      status: this.state(thread), updatedAt: Math.min(Date.now(), Math.floor((thread.updatedAt || Date.now() / 1000) * 1000)),
      capabilities: caps, archived: Boolean(thread.archived), pinned: Boolean(thread.isPinned),
      cwd: thread.cwd, model: thread.model, source: thread.threadSource,
      reasoningEffort: thread.reasoningEffort, mode: thread.collaborationMode?.mode,
      controlTransport: desktop ? 'desktop-ipc' : controlled ? 'app-server' : 'resume',
      controlReason: thread.archived ? '已归档 · 可查看完整历史' : unavailable ? this.blocked.get(thread.id) || '主机执行通道尚未连接，请保持桌面端在线' : desktop ? '桌面已连接 · 操作直接交给当前会话' : controlled ? '已连接 · 可远程操作' : '发送指令后继续此任务；沿用主机权限设置',
    };
    const signature = JSON.stringify([project, session]);
    if (this.published.get(thread.id) === signature) return;
    await this.client.request('/sessions', { project, session, allowProjectMove: this.hostScope });
    this.published.set(thread.id, signature);
  }

  async sync() {
    if (this.lazyHistory) return this.syncIndex();
    let cursor;
    let count = 0;
    do {
      const page = await this.rpc.request('thread/list', { cursor, limit: Math.min(50, this.maxThreads - count),
        sortKey: 'updated_at', sourceKinds, cwd: [...this.projects.keys()] });
      for (const summary of page.data || []) {
        count++;
        if (!this.projectFor(summary)) continue;
        await this.enqueue(async () => { try {
          const { thread } = await this.rpc.request('thread/read', { threadId: summary.id, includeTurns: true });
          this.threads.set(thread.id, thread);
          const active = thread.turns?.findLast((turn) => turn.status === 'inProgress');
          if (this.attached.has(thread.id)) {
            if (active) this.activeTurns.set(thread.id, active.id);
            else this.activeTurns.delete(thread.id);
          }
          if (this.rpc.url && thread.status?.type === 'active' && thread.canAcceptDirectInput === true && !this.attached.has(thread.id)) {
            await this.resume(thread);
          }
          await this.publish(thread);
          for (const turn of (thread.turns || []).slice(-20)) {
            for (const item of turn.items || []) {
              if (turn.status === 'inProgress' && (item.type === 'agentMessage' || item.status === 'inProgress')) continue;
              await this.item(thread.id, turn.id, item, true, (turn.completedAt || turn.startedAt || thread.updatedAt) * 1000);
            }
          }
        } catch (error) { this.onError(error); } });
      }
      cursor = page.nextCursor;
    } while (cursor && count < this.maxThreads);
    for (const request of this.requests.values()) {
      if (!request.responding && request.expiresAt > Date.now()) await this.publishRequest(request);
    }
  }

  async syncIndex() {
    const indexed = new Map();
    if (this.hostScope && !this.rpc.url) {
      try {
        const host = await this.hostIndex();
        for (const saved of host.projects) {
          const project = { id: saved.cwd, cwd: saved.cwd, name: saved.name, saved: true };
          this.projects.set(project.id, project);
          this.projectAssignments.set(saved.id, project);
          const signature = JSON.stringify(project);
          if (this.published.get(`project:${saved.id}`) !== signature) {
            await this.client.project(project);
            this.published.set(`project:${saved.id}`, signature);
          }
        }
        for (const thread of host.threads) indexed.set(thread.id, thread);
      } catch (error) { this.onError(new Error(`宿主机索引读取失败，使用协议列表：${error.message}`)); }
    }
    for (const archived of [false, true]) {
      let cursor;
      const cursors = new Set();
      do {
        const page = await this.rpc.request('thread/list', { cursor, limit: 100, archived,
          sortKey: 'updated_at', sourceKinds, modelProviders: [], useStateDbOnly: true,
          ...(!this.hostScope ? { cwd: [...this.projects.keys()] } : {}) });
        for (const summary of page.data || []) indexed.set(summary.id, { ...indexed.get(summary.id), ...summary, archived });
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Codex 返回重复分页游标');
        cursors.add(cursor);
      } while (cursor);
    }
    for (const summary of indexed.values()) {
      if (!this.projectFor(summary)) continue;
      const old = this.threads.get(summary.id);
      if (this.desktop?.has(summary.id)) { await this.desktop.project(summary.id); continue; }
      const thread = { ...old, ...summary, turns: old?.turns || [] };
      this.threads.set(thread.id, thread);
      if (this.rpc.url && !thread.archived && thread.status?.type === 'active' && thread.canAcceptDirectInput === true && !this.attached.has(thread.id)) {
        await this.resume(thread).catch(this.onError);
      }
      await this.publish(thread);
    }
    if (this.desktop) {
      const candidates = [...this.threads.values()].filter((t) => !t.archived && !this.desktop.has(t.id) && this.state(t) === 'running');
      for (let i = 0; i < candidates.length; i += 6) await Promise.allSettled(candidates.slice(i, i + 6).map((t) => this.desktop.follow(t.id)));
    }
  }

  async readHistory({ sessionId, cursor, limit = 40 }) {
    const thread = this.threadFor(sessionId);
    if (this.desktop && !thread.archived && !cursor) await this.desktop.follow(thread.id);
    const page = await this.rpc.request('thread/items/list', { threadId: thread.id,
      cursor: cursor || null, limit: Math.min(100, Math.max(1, limit)), sortDirection: 'desc' });
    const events = (page.data || []).map(({ turnId, item }) => historyEvent(thread.id, turnId, item, null)).filter(Boolean);
    return { events, nextCursor: page.nextCursor || null };
  }

  async catalog({ sessionId } = {}) {
    const thread = sessionId ? this.threadFor(sessionId) : null;
    if (thread && this.desktop && !thread.archived) await this.desktop.follow(thread.id);
    if (!this.models || Date.now() - this.modelsAt > 60000) {
      const models = []; let cursor;
      do {
        const page = await this.rpc.request('model/list', { cursor, limit: 100, includeHidden: false });
        models.push(...page.data); cursor = page.nextCursor;
      } while (cursor);
      this.models = models; this.modelsAt = Date.now();
    }
    return {
      models: this.models.map((m) => ({ id: m.model, name: m.displayName || m.model, description: m.description,
        reasoningEfforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort), defaultReasoningEffort: m.defaultReasoningEffort })),
      modes: [{ id: 'default', name: '执行' }, { id: 'plan', name: '计划' }],
      actions: [
        { id: 'skills.list', name: '主机技能', description: '查看此项目可用的技能' },
        { id: 'mcp.list', name: '工具与连接', description: '查看主机 MCP 工具服务' },
        { id: 'plugins.list', name: '主机插件', description: '查看已安装的插件' },
      ],
      settingsApply: 'next_turn', controlTransport: thread && this.desktop?.has(thread.id) ? 'desktop-ipc' : 'app-server',
    };
  }

  async configure({ sessionId, settings }) {
    let thread = this.threadFor(sessionId);
    const catalog = await this.catalog({ sessionId });
    const desktopState = this.desktop?.has(thread.id) ? await this.desktop.desktop.state(thread.id) : null;
    const modelId = settings.model || desktopState?.latestThreadSettings?.model || desktopState?.latestModel || thread.model || catalog.models[0]?.id;
    const model = catalog.models.find((m) => m.id === modelId);
    if (settings.model && !model) throw new Error('主机未提供这个模型，请刷新模型列表');
    if (settings.reasoningEffort && !model?.reasoningEfforts.includes(settings.reasoningEffort)) throw new Error('该模型不支持所选推理强度');
    if (settings.mode && !catalog.modes.some((m) => m.id === settings.mode)) throw new Error('不支持的工作模式');
    const patch = { ...settings.model ? { model: settings.model } : {},
      ...settings.reasoningEffort ? { effort: settings.reasoningEffort } : {} };
    const currentEffort = desktopState?.latestThreadSettings?.effort || thread.reasoningEffort;
    if (settings.model && !settings.reasoningEffort && currentEffort && !model.reasoningEfforts.includes(currentEffort)) {
      patch.effort = model.defaultReasoningEffort || null;
    }
    if (settings.mode) patch.collaborationMode = { mode: settings.mode,
      settings: { model: modelId, reasoning_effort: patch.effort ?? (model?.reasoningEfforts.includes(currentEffort) ? currentEffort : model?.defaultReasoningEffort) ?? null, developer_instructions: null } };
    let result;
    if (this.desktop?.has(thread.id)) result = await this.desktop.configure(thread.id, patch);
    else {
      if (!this.attached.has(thread.id)) thread = await this.resume(thread);
      result = await this.rpc.request('thread/settings/update', { threadId: thread.id, ...patch });
      if (settings.model) thread.model = settings.model;
      if (Object.hasOwn(patch, 'effort')) thread.reasoningEffort = patch.effort;
      if (patch.collaborationMode) thread.collaborationMode = patch.collaborationMode;
      await this.publish(thread);
    }
    return { confirmed: true, appliesTo: 'next_turn', settings, result };
  }

  async compact({ sessionId }) {
    let thread = this.threadFor(sessionId);
    if (this.state(thread) === 'running') throw new Error('请等当前执行结束后再压缩上下文');
    if (this.desktop && await this.desktop.follow(thread.id)) return this.desktop.compact(thread.id);
    if (!this.attached.has(thread.id)) thread = await this.resume(thread);
    return this.rpc.request('thread/compact/start', { threadId: thread.id });
  }

  async action({ sessionId, name }) {
    const thread = sessionId ? this.threadFor(sessionId) : null;
    if (name === 'skills.list') {
      const result = await this.rpc.request('skills/list', { cwds: thread ? [thread.cwd] : [...this.projects.keys()] });
      return { entries: result.data.flatMap((group) => group.skills.map((skill) => ({
        name: skill.interface?.displayName || skill.name, description: skill.shortDescription || skill.description,
        detail: skill.path, status: skill.enabled === false ? 'disabled' : 'available',
      }))), warnings: result.data.flatMap((group) => (group.errors || []).map((error) => error.message)) };
    }
    if (name === 'mcp.list') {
      const entries = []; let cursor;
      do {
        const result = await this.rpc.request('mcpServerStatus/list', { cursor, limit: 100 });
        entries.push(...result.data.map((server) => ({ name: server.name,
          description: server.serverInfo?.title || server.serverInfo?.name || '主机工具服务',
          detail: `${Object.keys(server.tools || {}).length} 个工具 · ${(server.resources || []).length} 个资源`,
          status: typeof server.runtimeStatus === 'string' ? server.runtimeStatus : server.runtimeStatus?.type || server.authStatus,
        })));
        cursor = result.nextCursor;
      } while (cursor);
      return { entries };
    }
    if (name === 'plugins.list') {
      const result = await this.rpc.request('plugin/installed', { cwds: thread ? [thread.cwd] : [] });
      return { entries: result.marketplaces.flatMap((marketplace) => marketplace.plugins.filter((plugin) => plugin.installed).map((plugin) => ({
        name: plugin.interface?.displayName || plugin.name, description: plugin.interface?.shortDescription,
        detail: plugin.localVersion || plugin.version || marketplace.name, status: plugin.enabled ? 'enabled' : 'disabled',
      }))), warnings: (result.marketplaceLoadErrors || []).map((error) => error.message) };
    }
    throw new Error('主机未提供此操作');
  }

  async resume(thread) {
    try {
      const result = await this.rpc.request('thread/resume', { threadId: thread.id });
      if (result.thread.canAcceptDirectInput === false) throw new Error('此 Codex 任务不接受直接输入');
      this.attached.add(thread.id);
      this.blocked.delete(thread.id);
      this.threads.set(thread.id, result.thread);
      const active = result.thread.turns?.findLast((t) => t.status === 'inProgress');
      if (active) this.activeTurns.set(thread.id, active.id);
      await this.publish(result.thread);
      return result.thread;
    } catch (error) {
      this.blocked.set(thread.id, clipped(error.message, 1000));
      this.blockedUntil.set(thread.id, Date.now() + 30000);
      await this.publish(thread);
      throw error;
    }
  }

  async startSession({ projectId, sessionId, text }) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('项目不在 CODEX_PROJECTS 中');
    const { thread } = await this.rpc.request('thread/start', { cwd: project.cwd, serviceName: 'xiaomeng_lan' });
    this.aliases[thread.id] = sessionId;
    await this.saveAliases();
    this.threads.set(thread.id, thread);
    this.attached.add(thread.id);
    await this.publish(thread);
    return this.sendMessage({ sessionId, text });
  }

  async sendMessage({ sessionId, text }) {
    let thread = this.threadFor(sessionId);
    if (this.desktop && await this.desktop.follow(thread.id)) return this.desktop.send(thread.id, text, false);
    if (!this.attached.has(thread.id)) thread = await this.resume(thread);
    if (thread.canAcceptDirectInput === false) throw new Error('此 Codex 任务不接受直接输入');
    if (this.activeTurns.has(thread.id) || this.state(thread) === 'running') throw new Error('任务正在运行，请使用追加指令');
    const { turn } = await this.rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
    const observed = this.threads.get(thread.id)?.turns?.find((t) => t.id === turn.id);
    if (turn.status === 'inProgress' && (!observed || observed.status === 'inProgress')) this.activeTurns.set(thread.id, turn.id);
    return { threadId: thread.id, turnId: turn.id };
  }

  async steer({ sessionId, text }) {
    const thread = this.threadFor(sessionId);
    if (this.desktop && await this.desktop.follow(thread.id)) return this.desktop.send(thread.id, text, true);
    const turnId = this.activeTurns.get(thread.id);
    if (!this.attached.has(thread.id) || !turnId) throw new Error('任务已结束或不可控，追加指令未发送');
    return this.rpc.request('turn/steer', { threadId: thread.id, expectedTurnId: turnId, input: [{ type: 'text', text }] });
  }

  async stop({ sessionId }) {
    const thread = this.threadFor(sessionId);
    if (this.desktop && await this.desktop.follow(thread.id)) return this.desktop.stop(thread.id);
    const turnId = this.activeTurns.get(thread.id);
    if (!this.attached.has(thread.id) || !turnId) throw new Error('此任务当前没有可停止的执行');
    await this.rpc.request('turn/interrupt', { threadId: thread.id, turnId });
    return { threadId: thread.id, turnId };
  }

  async event(threadId, type, key, fields) {
    const eventId = digest(`${threadId}\0${key}`);
    if (this.sentEvents.has(eventId)) return;
    await this.client.event(this.sessionId(threadId), type, { ...fields, eventId });
    this.sentEvents.add(eventId);
    if (this.sentEvents.size > 20000) this.sentEvents.delete(this.sentEvents.values().next().value);
  }

  async item(threadId, turnId, item, completed, createdAt, live = false) {
    const key = `${turnId}:${item.id}:${completed ? 'completed' : 'started'}`;
    this.items.set(`${threadId}:${item.id}`, item);
    if (this.items.size > 2000) this.items.delete(this.items.keys().next().value);
    const fields = { createdAt, turnId, itemId: item.id, phase: item.phase };
    if (item.type === 'userMessage' && completed) {
      await this.event(threadId, 'message.user', key, { ...fields, text: clipped(item.content?.map((c) => c.text || (c.type === 'text' ? '' : `[${c.type}]`)).join('\n')) });
    } else if (item.type === 'agentMessage' && completed) {
      const questions = item.questions?.map((q) => `\n\n${q.title}\n${q.options?.map((o) => `• ${o}`).join('\n') || ''}`).join('') || '';
      await this.event(threadId, 'message.assistant', key, { ...fields, text: clipped(item.text + questions, 256000) });
      if (live) {
        this.streams.delete(threadId);
        if (this.activeTurns.has(threadId)) await this.client.event(this.sessionId(threadId), 'assistant.delta', { text: '' });
      }
    } else if (item.type === 'reasoning' && completed && item.summary?.length) {
      await this.event(threadId, 'thinking', key, { ...fields, text: clipped(item.summary.join('\n')) });
    } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'plan', 'webSearch', 'exitedReviewMode'].includes(item.type)) {
      const toolName = { commandExecution: 'Terminal', fileChange: 'FileChange', plan: 'Plan', webSearch: 'WebSearch', exitedReviewMode: 'Review' }[item.type] || `${item.server || ''}/${item.tool}`;
      const text = item.type === 'commandExecution' ? `${item.command}\n${completed ? item.aggregatedOutput || '' : ''}`
        : item.type === 'fileChange' ? item.changes.map((c) => `${c.path}\n${c.diff}`).join('\n\n')
        : item.text || item.review || toolResult(item.result || item.arguments || item.action);
      await this.event(threadId, completed ? 'tool.finished' : 'tool.started', key, { ...fields, toolName, toolCallId: `${turnId}:${item.id}`,
        toolInput: item.type === 'commandExecution' ? clipped(item.command) : item.arguments == null ? null : clipped(toolResult(item.arguments)),
        text: clipped(text), ok: completed ? !['failed', 'declined'].includes(item.status) && item.success !== false : null });
      if (completed) {
        clearTimeout(this.toolStreams.get(`${threadId}:${item.id}`)?.timer);
        this.toolStreams.delete(`${threadId}:${item.id}`);
      }
    }
  }

  async notification({ method, params: p }) {
    if (method === 'serverRequest/resolved') {
      const request = this.requests.get(JSON.stringify(p.requestId));
      if (request) {
        clearTimeout(request.timer);
        this.requests.delete(JSON.stringify(p.requestId));
        request.confirm?.resolve({ confirmed: true });
        await this.client.resolveApproval(request.id, request.outcome || 'expired');
      }
      return;
    }
    const thread = this.threads.get(p.threadId);
    if (!thread || !this.projectFor(thread)) return;
    if (method === 'thread/settings/updated') {
      thread.model = p.threadSettings.model; thread.reasoningEffort = p.threadSettings.effort;
      thread.collaborationMode = p.threadSettings.collaborationMode;
      await this.publish(thread); return;
    }
    if (method === 'turn/started') {
      this.activeTurns.set(thread.id, p.turn.id);
      thread.updatedAt = Date.now() / 1000;
      await this.client.event(this.sessionId(thread.id), 'assistant.start', { turnId: p.turn.id });
      await this.publish(thread);
    } else if (method === 'turn/completed') {
      this.activeTurns.delete(thread.id);
      this.streams.delete(thread.id);
      thread.status = { type: 'idle' };
      thread.turns = [...(thread.turns || []).filter((t) => t.id !== p.turn.id), p.turn];
      thread.updatedAt = Date.now() / 1000;
      for (const item of p.turn.items || []) await this.item(thread.id, p.turn.id, item, true, Date.now());
      await this.client.event(this.sessionId(thread.id), 'assistant.done', { ok: p.turn.status !== 'failed', aborted: p.turn.status === 'interrupted', error: clipped(p.turn.error?.message, 2000) });
      await this.publish(thread);
      for (const request of [...this.requests.values()]) if (request.params.threadId === thread.id && request.params.turnId === p.turn.id) await this.expireRequest(request);
    } else if (method === 'item/agentMessage/delta') {
      const text = clipped((this.streams.get(thread.id) || '') + p.delta, 256000);
      this.streams.set(thread.id, text);
      await this.client.event(this.sessionId(thread.id), 'assistant.delta', { text, turnId: p.turnId, itemId: p.itemId, phase: this.items.get(`${thread.id}:${p.itemId}`)?.phase });
    } else if (method === 'item/started' || method === 'item/completed') {
      await this.item(thread.id, p.turnId, p.item, method === 'item/completed', Date.now(), true);
    } else if (method === 'item/commandExecution/outputDelta') {
      const key = `${thread.id}:${p.itemId}`;
      const output = this.toolStreams.get(key) || { text: '', lastAt: 0, count: 0 };
      output.text = (output.text + p.delta).slice(-64000);
      this.toolStreams.set(key, output);
      if (Date.now() - output.lastAt >= 500) {
        await this.flushToolOutput(thread.id, p.turnId, p.itemId, output);
      } else if (!output.timer) {
        output.timer = setTimeout(() => {
          output.timer = null;
          this.enqueue(() => this.flushToolOutput(thread.id, p.turnId, p.itemId, output)).catch(() => {});
        }, 500 - (Date.now() - output.lastAt));
      }
    } else if (method === 'turn/diff/updated') {
      await this.event(thread.id, 'tool.finished', `diff:${p.turnId}:${digest(p.diff)}`, { toolName: 'Diff', text: clipped(p.diff) });
    } else if (method === 'turn/plan/updated') {
      await this.event(thread.id, 'tool.finished', `plan:${p.turnId}:${digest(JSON.stringify(p.plan))}`, { toolName: 'Plan', text: clipped(p.plan.map((step) => `${step.status}: ${step.step}`).join('\n')) });
    } else if (method === 'thread/status/changed') {
      thread.status = p.status;
      if (p.status.type === 'notLoaded') {
        this.attached.delete(thread.id);
        this.activeTurns.delete(thread.id);
      }
      await this.publish(thread);
    } else if (method === 'thread/closed') {
      this.attached.delete(thread.id);
      this.activeTurns.delete(thread.id);
      thread.status = { type: 'notLoaded' };
      await this.publish(thread);
    }
  }

  async flushToolOutput(threadId, turnId, itemId, output) {
    if (this.closed || this.toolStreams.get(`${threadId}:${itemId}`) !== output) return;
    output.lastAt = Date.now();
    await this.event(threadId, 'tool.output', `output:${this.instance}:${turnId}:${itemId}:${output.count++}`, {
      toolName: 'Terminal', toolCallId: `${turnId}:${itemId}`, text: output.text, turnId, itemId,
    });
  }

  async serverRequest(message) {
    const { id, method, params: p } = message;
    const thread = this.threads.get(p.threadId);
    if (!thread || !this.projectFor(thread)) { this.rpc.reject(id, 'Thread is outside configured projects'); return; }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'].includes(method)) {
      if (method === 'mcpServer/elicitation/request') this.rpc.respond(id, { action: 'decline', content: null });
      else this.rpc.reject(id);
      await this.event(thread.id, 'task.status', `unsupported:${this.instance}:${id}`, { text: `主机请求 ${method} 暂不支持，请在主机处理` });
      return;
    }
    const request = { ...message, id: `codex:${this.instance}:${id}`, rpcId: id, expiresAt: Date.now() + this.approvalTtlMs };
    this.requests.set(JSON.stringify(id), request);
    request.timer = setTimeout(() => { this.enqueue(() => this.expireRequest(request)).catch(() => {}); }, this.approvalTtlMs);
    await this.publishRequest(request);
  }

  async publishRequest(request) {
    const p = request.params;
    const item = this.items.get(`${p.threadId}:${p.itemId}`);
    const input = request.method === 'item/tool/requestUserInput';
    const file = request.method === 'item/fileChange/requestApproval';
    const permissions = request.method === 'item/permissions/requestApproval';
    const details = permissions ? JSON.stringify(p.permissions, null, 2)
      : p.networkApprovalContext ? JSON.stringify(p.networkApprovalContext, null, 2)
      : [p.command || item?.command, p.reason, p.additionalPermissions ? JSON.stringify(p.additionalPermissions, null, 2) : ''].filter(Boolean).join('\n\n');
    await this.client.approval({ id: request.id, sessionId: this.sessionId(p.threadId),
      kind: input ? 'input' : file ? 'file_edit' : 'command',
      title: input ? 'Codex 需要你的回复' : clipped(p.reason || (permissions ? 'Codex 请求额外权限' : file ? 'Codex 请求修改文件' : 'Codex 请求执行操作'), 1000),
      command: clipped(details), filePath: clipped(item?.changes?.map((c) => c.path).join(', '), 4096),
      diff: clipped(item?.changes?.map((c) => `${c.path}\n${c.diff}`).join('\n\n')),
      questions: input ? p.questions : undefined, ttlMs: Math.max(1000, request.expiresAt - Date.now()),
    });
  }

  response(request, payload) {
    const approve = payload.decision === 'approve';
    if (request.method === 'item/tool/requestUserInput') {
      if (!approve) return { answers: {} };
      return { answers: Object.fromEntries(request.params.questions.map((q) => {
        const value = payload.answers?.[q.id];
        if (typeof value !== 'string' || !value.trim()) throw new Error('请回答所有问题');
        return [q.id, { answers: [value] }];
      })) };
    }
    if (request.method === 'item/permissions/requestApproval') return { permissions: approve ? request.params.permissions : {}, scope: 'turn' };
    const available = request.params.availableDecisions;
    const decision = approve ? 'accept' : available?.includes('decline') || !available ? 'decline' : 'cancel';
    if (available && !available.includes(decision)) throw new Error('Codex 未提供本次授权选项，请在主机处理');
    return { decision };
  }

  async answer(payload) {
    if (this.desktop?.requests.has(payload.approvalId)) return this.desktop.answer(payload);
    const request = [...this.requests.values()].find((r) => r.id === payload.approvalId);
    if (!request || request.expiresAt <= Date.now() || request.responding) throw new Error('问题或审批已结束');
    const response = this.response(request, payload);
    request.responding = true;
    request.outcome = payload.decision === 'approve' ? 'approved' : 'denied';
    // A pipe write is not a receipt: wait for the host to resolve this exact request.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex 审批确认超时，结果未知')), 20000);
      request.confirm = { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      try { this.rpc.respond(request.rpcId, response); } catch (error) { request.confirm.reject(error); }
    });
  }

  async expireRequest(request) {
    if (!this.requests.delete(JSON.stringify(request.rpcId))) return;
    clearTimeout(request.timer);
    request.confirm?.reject(new Error('Codex 请求已结束'));
    if (!request.responding && this.rpc.ready) this.rpc.respond(request.rpcId, this.response(request, { decision: 'reject' }));
    await this.client.resolveApproval(request.id, 'expired');
  }

  async close() {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.timer);
    this.desktop?.close();
    for (const output of this.toolStreams.values()) clearTimeout(output.timer);
    for (const request of [...this.requests.values()]) await this.expireRequest(request).catch(this.onError);
    await this.rpc.close();
    await this.serial;
    await this.client.close();
  }
}
