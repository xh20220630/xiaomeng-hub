import { createHash } from 'node:crypto';
import { desktopTurns } from './codex-desktop.mjs';

const key = (value) => createHash('sha256').update(value).digest('hex');
const approvalMethods = {
  'item/commandExecution/requestApproval': 'command-approval-decision',
  'item/fileChange/requestApproval': 'file-approval-decision',
  'item/permissions/requestApproval': 'permissions-request-approval-response',
  'item/tool/requestUserInput': 'submit-user-input',
};

export class CodexDesktopBridge {
  constructor(adapter, desktop) {
    this.adapter = adapter; this.desktop = desktop; this.timers = new Map(); this.lastTurns = new Map();
    this.outputs = new Map(); this.requests = new Map();
    desktop.on('warning', adapter.onError);
    desktop.on('state', (id) => {
      if (!this.timers.has(id)) this.timers.set(id, setTimeout(() => {
        this.timers.delete(id); adapter.enqueue(() => this.project(id));
      }, 80));
    });
    desktop.on('lost', (id) => {
      const thread = adapter.threads.get(id);
      if (thread) { thread.desktopOwned = false; adapter.enqueue(() => adapter.publish(thread)); }
      for (const request of this.requests.values()) if (request.params.threadId === id) {
        request.confirm?.reject(new Error('桌面已断开，审批结果未知'));
        this.requests.delete(request.id);
        adapter.enqueue(() => adapter.client.resolveApproval(request.id));
      }
    });
  }

  has(id) { return this.desktop.has(id); }
  async follow(id) {
    try { return await this.desktop.follow(id); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) this.adapter.onError(error); return false; }
  }

  async project(id) {
    const state = this.desktop.states.get(id), adapter = this.adapter;
    if (!state || !this.has(id)) return;
    const turns = desktopTurns(state), last = turns.at(-1);
    const thread = { ...adapter.threads.get(id), id, cwd: state.cwd, name: state.title,
      status: state.threadRuntimeStatus, lastTurnStatus: last?.status,
      model: state.latestThreadSettings?.model || state.latestModel,
      reasoningEffort: state.latestThreadSettings?.effort || state.latestReasoningEffort,
      collaborationMode: state.latestThreadSettings?.collaborationMode || state.latestCollaborationMode, updatedAt: state.updatedAt / 1000,
      turns: last ? [{ id: last.turnId, status: last.status }] : [], desktopOwned: true };
    if (!adapter.projectFor(thread)) return;
    adapter.threads.set(id, thread);
    await adapter.publish(thread);
    const previous = this.lastTurns.get(id);
    const running = last?.status === 'inProgress';
    if (running && (previous?.id !== last.turnId || previous.status !== 'inProgress')) await adapter.client.event(adapter.sessionId(id), 'assistant.start', { turnId: last.turnId });
    this.lastTurns.set(id, { id: last?.turnId, status: last?.status });
    if (last) {
      const latest = last.items?.at(-1);
      for (const item of last.items || []) {
        if (item.type === 'agentMessage' && running && latest === item) {
          const outputKey = `${id}:assistant`;
          if (this.outputs.get(outputKey) !== item.text) {
            this.outputs.set(outputKey, item.text);
            await adapter.client.event(adapter.sessionId(id), 'assistant.delta', { text: (item.text || '').slice(0, 256000), phase: item.phase, itemId: item.id, turnId: last.turnId });
          }
        } else if (item.status === 'inProgress') {
          await adapter.item(id, last.turnId, item, false, last.turnStartedAtMs);
          if (item.type === 'commandExecution' && this.outputs.get(`${id}:${item.id}`) !== item.aggregatedOutput) {
            this.outputs.set(`${id}:${item.id}`, item.aggregatedOutput);
            await adapter.client.event(adapter.sessionId(id), 'tool.output', { toolName: 'Terminal', toolCallId: `${last.turnId}:${item.id}`, turnId: last.turnId, itemId: item.id, text: (item.aggregatedOutput || '').slice(-64000) });
          }
        } else await adapter.item(id, last.turnId, item, true, last.turnStartedAtMs);
      }
      if (latest?.type !== 'agentMessage' && this.outputs.has(`${id}:assistant`)) {
        this.outputs.delete(`${id}:assistant`);
        await adapter.client.event(adapter.sessionId(id), 'assistant.delta', { text: '' });
      }
    }
    if (!running && previous?.status === 'inProgress') {
      this.outputs.delete(`${id}:assistant`);
      await adapter.client.event(adapter.sessionId(id), 'assistant.done', { ok: last?.status !== 'failed', aborted: last?.status === 'interrupted' });
    }
    await this.syncRequests(id, state.requests || []);
  }

  async syncRequests(id, requests) {
    const current = new Set();
    for (const raw of requests) {
      if (!approvalMethods[raw.method]) continue;
      const requestId = `desktop:${key(`${id}:${raw.id}`)}`;
      current.add(requestId);
      if (this.requests.has(requestId)) continue;
      const request = { ...raw, rpcId: raw.id, id: requestId, params: { ...raw.params, threadId: id }, expiresAt: Date.now() + this.adapter.approvalTtlMs };
      this.requests.set(requestId, request);
      await this.adapter.publishRequest(request);
    }
    for (const request of this.requests.values()) if (request.params.threadId === id && !current.has(request.id)) {
      this.requests.delete(request.id);
      request.confirm?.resolve({ confirmed: true });
      await this.adapter.client.resolveApproval(request.id, request.outcome || 'expired');
    }
  }

  async send(id, text, steer) {
    const state = await this.desktop.state(id);
    const input = [{ type: 'text', text, text_elements: [] }];
    if (steer) {
      const active = desktopTurns(state).at(-1);
      if (active?.status !== 'inProgress') throw new Error('本轮已结束，请刷新后发送新消息');
      return this.desktop.call(id, 'steer-turn', { input, attachments: [],
        restoreMessage: { id: key(text + Date.now()), text, cwd: state.cwd, createdAt: Date.now(),
          context: { prompt: text, addedFiles: [], fileAttachments: [], imageAttachments: [], workspaceRoots: [state.cwd] } } });
    }
    return this.desktop.call(id, 'start-turn', { turnStart: { request: { threadId: id, input }, context: { inheritThreadSettings: true } } });
  }

  async stop(id) {
    const turn = desktopTurns(await this.desktop.state(id)).at(-1);
    if (!turn?.turnId || turn.status !== 'inProgress') throw new Error('当前没有可停止的执行轮次');
    return this.desktop.call(id, 'interrupt-turn', { mode: 'user-stop', expectedTurnId: turn.turnId });
  }

  configure(id, threadSettings) { return this.desktop.call(id, 'update-thread-settings', { threadSettings }); }
  compact(id) { return this.desktop.call(id, 'compact-thread'); }

  async answer(payload) {
    const request = this.requests.get(payload.approvalId);
    if (!request || request.responding) throw new Error('问题已结束或正在处理');
    const response = this.adapter.response(request, payload);
    request.responding = true; request.outcome = payload.decision === 'approve' ? 'approved' : 'denied';
    const confirmation = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('桌面尚未确认审批，结果未知')), 20000);
      request.confirm = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } };
    });
    confirmation.catch(() => {});
    try {
      await this.desktop.call(request.params.threadId, approvalMethods[request.method], { requestId: request.rpcId,
        ...(response.decision ? { decision: response.decision } : { response }) });
    } catch (error) { request.responding = false; request.confirm.reject(error); }
    return confirmation;
  }

  close() { for (const timer of this.timers.values()) clearTimeout(timer); this.desktop.close(); }
}
