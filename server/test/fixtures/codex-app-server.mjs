import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const cwd = process.env.FIXTURE_PROJECT;
const time = Math.floor(Date.now() / 1000);
const history = { id: 'history', cwd, name: '历史任务', preview: 'Fixture', createdAt: time - 100, updatedAt: time - 10,
  status: { type: 'notLoaded' }, canAcceptDirectInput: null,
  turns: [{ id: 'old-turn', status: 'completed', completedAt: time - 10, items: [{ id: 'old-output', type: 'agentMessage', text: '历史输出' }] }] };
const busy = { ...history, id: 'external-busy', name: '其他客户端任务', canAcceptDirectInput: process.env.FIXTURE_SHARED === '1',
  status: { type: 'active' }, turns: [{ id: 'external-turn', status: 'inProgress', items: [] }] };
const threads = new Map([[history.id, history], [busy.id, busy]]);
const requests = new Map();
let requestId = 1000;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });

function item(thread, turn, item) {
  turn.items.push(item);
  notify('item/started', { threadId: thread.id, turnId: turn.id, item });
  notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
}

function finish(thread, status = 'completed') {
  const turn = thread.turns.at(-1);
  if (!turn || turn.status !== 'inProgress') return;
  turn.status = status;
  turn.completedAt = time;
  thread.status = { type: 'idle' };
  if (status === 'completed') {
    notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: `${turn.id}-assistant`, delta: '实时输出' });
    item(thread, turn, { id: `${turn.id}-assistant`, type: 'agentMessage', text: '任务执行完成' });
    notify('turn/diff/updated', { threadId: thread.id, turnId: turn.id, diff: '--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new' });
  }
  notify('turn/completed', { threadId: thread.id, turn });
  for (const [id, pending] of requests) if (pending.thread.id === thread.id) {
    requests.delete(id);
    notify('serverRequest/resolved', { threadId: thread.id, requestId: id });
  }
}

function ask(thread, turn, text) {
  const id = ++requestId;
  let method;
  let params = { threadId: thread.id, turnId: turn.id, itemId: 'tool' };
  if (text === 'question') {
    method = 'item/tool/requestUserInput';
    params.questions = [{ id: 'choice', question: '选择部署环境', isSecret: false, options: [{ label: '测试', description: '测试环境' }] }];
  } else if (text === 'file') {
    method = 'item/fileChange/requestApproval';
    params.reason = '修改 fixture.txt';
    notify('item/started', { threadId: thread.id, turnId: turn.id,
      item: { id: 'tool', type: 'fileChange', changes: [{ path: `${cwd}/fixture.txt`, diff: '-old\n+new' }], status: 'inProgress' } });
  } else if (text === 'permissions') {
    method = 'item/permissions/requestApproval';
    params.permissions = { network: { enabled: true }, fileSystem: null };
  } else {
    method = 'item/commandExecution/requestApproval';
    params.command = 'echo fixture';
    params.availableDecisions = ['accept', 'decline'];
  }
  requests.set(id, { thread, text });
  send({ id, method, params });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id);
    const turn = pending.thread.turns.at(-1);
    item(pending.thread, turn, { id: `response-${message.id}`, type: 'agentMessage', text: JSON.stringify(message.result) });
    if (pending.text !== 'no-confirm') notify('serverRequest/resolved', { threadId: pending.thread.id, requestId: message.id });
    finish(pending.thread);
    return;
  }
  if (message.id == null) return;
  const p = message.params || {};
  const thread = threads.get(p.threadId);
  let result;
  switch (message.method) {
    case 'initialize': result = { userAgent: 'fixture/0.154.0' }; break;
    case 'model/list': result = { data: [{ model: 'fixture-model', displayName: 'Fixture model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }], nextCursor: null }; break;
    case 'thread/settings/update':
      result = { model: p.model, effort: p.effort, collaborationMode: p.collaborationMode };
      notify('thread/settings/updated', { threadId: thread.id, threadSettings: result }); break;
    case 'thread/compact/start': result = {}; break;
    case 'skills/list': result = { data: [{ cwd, skills: [{ name: 'fixture-skill', description: 'Host skill' }] }] }; break;
    case 'mcpServerStatus/list': result = { data: [], nextCursor: null }; break;
    case 'plugin/installed': result = { marketplaces: [] }; break;
    case 'thread/list': result = { data: p.archived ? [] : [...threads.values()], nextCursor: null }; break;
    case 'thread/items/list': {
      const items = thread.turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))).reverse();
      const offset = Number(p.cursor || 0);
      const end = offset + (p.limit || 40);
      result = { data: items.slice(offset, end), nextCursor: end < items.length ? String(end) : null };
      break;
    }
    case 'thread/read': result = { thread }; break;
    case 'thread/resume':
      if (thread?.id === 'external-busy' && !thread.canAcceptDirectInput) { send({ id: message.id, error: { code: -32000, message: 'Thread already open in another client' } }); return; }
      thread.status = { type: thread.turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' }; thread.canAcceptDirectInput = true;
      result = { thread }; break;
    case 'thread/start': {
      const created = { ...history, id: randomUUID(), cwd: p.cwd, name: '新任务', status: { type: 'idle' }, canAcceptDirectInput: true, turns: [] };
      threads.set(created.id, created);
      result = { thread: created }; break;
    }
    case 'turn/start': {
      const text = p.input[0].text;
      const turn = { id: randomUUID(), status: 'inProgress', startedAt: time, items: [] };
      thread.turns.push(turn); thread.status = { type: 'active' };
      send({ id: message.id, result: { turn } });
      notify('turn/started', { threadId: thread.id, turn });
      item(thread, turn, { id: `${turn.id}-user`, type: 'userMessage', content: p.input });
      if (text === 'terminal') {
        notify('item/started', { threadId: thread.id, turnId: turn.id, item: { id: 'terminal', type: 'commandExecution', command: 'fixture', status: 'inProgress' } });
        notify('item/commandExecution/outputDelta', { threadId: thread.id, turnId: turn.id, itemId: 'terminal', delta: 'test output while running' });
        notify('item/commandExecution/outputDelta', { threadId: thread.id, turnId: turn.id, itemId: 'terminal', delta: ' plus final buffered chunk' });
        return;
      }
      if (text === 'hold') return;
      if (['question', 'file', 'permissions', 'approval', 'no-confirm'].includes(text)) ask(thread, turn, text);
      else finish(thread);
      return;
    }
    case 'turn/steer': {
      const turn = thread.turns.at(-1);
      if (turn.id !== p.expectedTurnId || turn.status !== 'inProgress') { send({ id: message.id, error: { code: -32000, message: 'No active turn' } }); return; }
      item(thread, turn, { id: randomUUID(), type: 'userMessage', content: p.input });
      result = { turnId: turn.id }; break;
    }
    case 'turn/interrupt':
      result = {};
      finish(thread, 'interrupted'); break;
    default: send({ id: message.id, error: { code: -32601, message: `Unknown ${message.method}` } }); return;
  }
  send({ id: message.id, result });
});
