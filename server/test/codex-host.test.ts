/** 验证Codex 主机索引与状态，使用隔离的测试资源。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readCodexHostIndex } from '../src/adapters/codex/codex-host-index.js';
import { createTestAgent } from './fixtures/agent.js';
import type { EventInput, SessionInput } from '../src/types/domain.js';
import type { CodexTurn } from '../src/types/codex.js';
import { historyEvent, toolResult } from '../src/adapters/codex/codex-history.js';

test('host index includes archived and legacy records and never modifies the source database', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-host-test-'));
  try {
    const file = path.join(dir, 'state_5.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER);
      INSERT INTO threads VALUES('legacy','/work','Older task',1,2,0),('archived','/work','Archived task',1,2,1);
      CREATE TABLE projects(id TEXT,name TEXT,position INTEGER);
      CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER);
      INSERT INTO projects VALUES('saved','Empty saved project',0);
      INSERT INTO project_roots VALUES('saved','/empty',0);`);
    db.close();
    const historyFile = path.join(dir, 'thread_history_1.sqlite');
    const history = new DatabaseSync(historyFile);
    history.exec(`CREATE TABLE thread_turns(thread_id TEXT,rollout_ordinal INTEGER,status TEXT);
      INSERT INTO thread_turns VALUES('legacy',1,'completed'),('legacy',2,'inProgress');`);
    history.close();
    const historyBefore = await readFile(historyFile);
    const before = await readFile(file);
    const index = await readCodexHostIndex(dir);
    assert.equal(index.threads.length, 2);
    assert.equal(index.threads.find((t) => t.id === 'archived')!.archived, true);
    assert.equal(index.projects[0].name, 'Empty saved project');
    assert.equal(index.threads.find((t) => t.id === 'legacy')!.lastTurnStatus, 'inProgress');
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readFile(historyFile), historyBefore);
  } finally {
    if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('xiaomeng-host-test-'))
      await rm(dir, { recursive: true, force: true });
  }
});

test('tool history keeps text while excluding binary image payloads and metadata', () => {
  assert.equal(toolResult([{ type: 'image', data: 'binary-payload' }]), '[图片结果]');
  assert.equal(
    toolResult({ type: 'input_image', image_url: 'data:image/png;base64,binary-payload' }),
    '[图片结果]',
  );
  const event = historyEvent('thread', 'turn', {
    id: 'tool',
    type: 'mcpToolCall',
    tool: 'capture',
    result: {
      content: [
        { type: 'text', text: 'Screen captured' },
        { type: 'image', data: 'binary-payload' },
      ],
      _meta: { screenshot: 'binary-payload' },
    },
  });
  assert.equal(event!.detail, 'Screen captured\n\n[图片结果]');
  assert.ok(!JSON.stringify(event).includes('binary-payload'));
});

test('history preserves reply phase and separates tool input from its result', () => {
  const progress = historyEvent('thread', 'turn', {
    id: 'progress',
    type: 'agentMessage',
    text: 'Checking files',
    phase: 'commentary',
  });
  assert.equal(progress!.phase, 'commentary');
  assert.equal(progress!.turn_id, 'turn');
  assert.equal(progress!.item_id, 'progress');
  assert.equal(
    historyEvent('thread', 'turn', {
      id: 'reply',
      type: 'agentMessage',
      text: 'Done',
      phase: 'final_answer',
    })!.phase,
    'final_answer',
  );
  const tool = historyEvent('thread', 'turn', {
    id: 'tool',
    type: 'mcpToolCall',
    arguments: { title: 'Inspect page' },
    result: { content: [{ type: 'text', text: 'Page ready' }] },
  });
  assert.equal(JSON.parse(tool!.tool_input!).title, 'Inspect page');
  assert.equal(tool!.detail, 'Page ready');
});

test('live item and text deltas preserve the same phase and identity as history', async () => {
  const published: EventInput[] = [];
  const cwd = path.resolve('host-project');
  const adapter = createTestAgent({
    rpc: new EventEmitter(),
    projects: [cwd],
    client: {
      isAvailable: () => true,
      event: async (_session: string, type: string, fields: EventInput) =>
        published.push({ type, ...fields }),
    },
  });
  adapter.threads.set('thread', { id: 'thread', cwd });
  await adapter.item(
    'thread',
    'turn',
    { id: 'reply', type: 'agentMessage', phase: 'commentary', text: '' },
    false,
  );
  await adapter.notification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'reply', delta: 'Checking files' },
  });
  await adapter.item(
    'thread',
    'turn',
    { id: 'reply', type: 'agentMessage', phase: 'commentary', text: 'Checking files' },
    true,
  );
  assert.deepEqual(
    published.map((event) => [event.type, event.phase, event.turnId, event.itemId]),
    [
      ['assistant.delta', 'commentary', 'turn', 'reply'],
      ['message.assistant', 'commentary', 'turn', 'reply'],
    ],
  );
});

test('unfinished host turns are read-only until attached to the executing server', async () => {
  const published: SessionInput[] = [];
  const adapter = createTestAgent({
    rpc: new EventEmitter(),
    projects: [path.resolve('host-project')],
    client: {
      isAvailable: () => true,
      request: async (_: string, body: SessionInput) => published.push(body),
    },
  });
  await adapter.publish({
    id: 'active',
    cwd: path.resolve('host-project'),
    lastTurnStatus: 'inProgress',
  });
  assert.equal(published[0].session.status, 'running');
  assert.deepEqual(published[0].session.capabilities, []);
});

test('host discovery follows every page, includes archived/legacy tasks, and publishes only changes', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const published: SessionInput[] = [];
  const project = path.resolve('host-project');
  const summaries = Array.from({ length: 135 }, (_, i) => ({
    id: `thread-${i}`,
    cwd: project,
    name: `Task ${i}`,
    updatedAt: 1000 + i,
  }));
  const rpc = Object.assign(new EventEmitter(), {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      assert.equal(method, 'thread/list');
      if (params.archived)
        return { data: [{ id: 'archive', cwd: project, updatedAt: 1000 }], nextCursor: null };
      return params.cursor
        ? { data: summaries.slice(100), nextCursor: null }
        : { data: summaries.slice(0, 100), nextCursor: 'next' };
    },
  });
  const client = {
    isAvailable: () => true,
    project: async () => {},
    request: async (_: string, body: SessionInput) => published.push(body),
  };
  const adapter = createTestAgent({
    rpc,
    client,
    projects: [],
    hostScope: true,
    lazyHistory: true,
    hostIndex: async () => ({
      projects: [{ id: 'saved', cwd: project, name: 'Saved project' }],
      threads: [{ id: 'legacy-only', cwd: project, updatedAt: 100 }],
    }),
  });
  await adapter.syncIndex();
  assert.equal(adapter.threads.size, 137);
  assert.equal(published.length, 137);
  assert.ok(published.find((p) => p.session.id === 'archive')!.session.archived);
  assert.ok(calls.every(([, params]) => !Object.hasOwn(params, 'cwd')));
  assert.equal(calls.length, 3);
  await adapter.syncIndex();
  assert.equal(published.length, 137, 'unchanged catalog must not flood connected clients');
  summaries[0].updatedAt++;
  await adapter.syncIndex();
  assert.equal(published.length, 138);
});

test('history pages preserve cursor and stable item identities without resuming a task', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const rpc = Object.assign(new EventEmitter(), {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      return {
        data: [
          { turnId: 'turn', item: { id: 'output', type: 'agentMessage', text: 'Full output' } },
        ],
        nextCursor: 'older',
      };
    },
  });
  const project = path.resolve('host-project');
  const adapter = createTestAgent({
    rpc,
    client: { isAvailable: () => true },
    projects: [project],
  });
  adapter.threads.set('thread', { id: 'thread', cwd: project });
  const page = await adapter.readHistory({ sessionId: 'thread', cursor: 'requested', limit: 40 });
  assert.equal(calls[0][0], 'thread/items/list');
  assert.equal(calls[0][1].cursor, 'requested');
  assert.equal(page.nextCursor, 'older');
  assert.equal(page.events[0]!.detail, 'Full output');
  assert.equal(
    page.events[0]!.event_key,
    historyEvent('thread', 'turn', { id: 'output', type: 'agentMessage', text: 'Full output' })!
      .event_key,
  );
});

test('fresh host index status replaces cached turns without reverting a newer live turn', async () => {
  const project = path.resolve('host-project');
  const published: SessionInput[] = [];
  let updatedAt = 2000;
  let lastTurnStatus = 'completed';
  const adapter = createTestAgent({
    rpc: Object.assign(new EventEmitter(), {
      request: async () => ({ data: [], nextCursor: null }),
    }),
    client: {
      isAvailable: () => true,
      request: async (_: string, body: SessionInput) => published.push(body),
    },
    projects: [project],
    hostScope: true,
    lazyHistory: true,
    hostIndex: async () => ({
      projects: [],
      threads: [
        { id: 'thread', cwd: project, updatedAt, lastTurnStatus, status: { type: 'notLoaded' } },
      ],
    }),
  });
  adapter.threads.set('thread', {
    id: 'thread',
    cwd: project,
    updatedAt: 1000,
    status: { type: 'active' },
    turns: [{ id: 'old-turn', status: 'inProgress' }],
  });
  adapter.activeTurns.set('thread', 'old-turn');
  await adapter.syncIndex();
  assert.equal(published.at(-1)!.session.status, 'done');
  assert.equal(adapter.activeTurns.has('thread'), false);

  updatedAt = 3000;
  lastTurnStatus = 'inProgress';
  await adapter.syncIndex();
  assert.equal(published.at(-1)!.session.status, 'running');

  adapter.threads.set('thread', {
    id: 'thread',
    cwd: project,
    updatedAt: 4000,
    status: { type: 'active' },
    turns: [{ id: 'new-turn', status: 'inProgress' }],
  });
  adapter.activeTurns.set('thread', 'new-turn');
  lastTurnStatus = 'completed';
  await adapter.syncIndex();
  assert.equal(published.at(-1)!.session.status, 'running');
  assert.equal(adapter.activeTurns.get('thread'), 'new-turn');
});

for (const [turnStatus, sessionStatus] of [
  ['completed', 'done'],
  ['failed', 'error'],
  ['interrupted', 'paused'],
]) {
  test(`same-second host index ${turnStatus} resolves a missed completion of the active turn`, async () => {
    const project = path.resolve('host-project');
    const published: SessionInput[] = [];
    let reads = 0;
    const adapter = createTestAgent({
      rpc: Object.assign(new EventEmitter(), {
        request: async (method: string) => {
          if (method !== 'thread/read') return { data: [], nextCursor: null };
          reads++;
          return {
            thread: {
              id: 'thread',
              cwd: project,
              updatedAt: 2000,
              status: { type: 'active' },
              turns: [{ id: 'active-turn', status: turnStatus }],
            },
          };
        },
      }),
      client: {
        isAvailable: () => true,
        request: async (_: string, body: SessionInput) => published.push(body),
      },
      projects: [project],
      hostScope: true,
      lazyHistory: true,
      hostIndex: async () => ({
        projects: [],
        threads: [
          {
            id: 'thread',
            cwd: project,
            updatedAt: 2000,
            lastTurnStatus: turnStatus,
            status: { type: 'notLoaded' },
          },
        ],
      }),
    });
    adapter.threads.set('thread', {
      id: 'thread',
      cwd: project,
      updatedAt: 2000.8,
      status: { type: 'active' },
      turns: [{ id: 'active-turn', status: 'inProgress' }],
    });
    adapter.activeTurns.set('thread', 'active-turn');
    adapter.streams.set('thread', 'Processing');
    await adapter.syncIndex();
    await adapter.syncIndex();
    assert.equal(published.at(-1)!.session.status, sessionStatus);
    assert.equal(adapter.activeTurns.has('thread'), false);
    assert.equal(adapter.streams.has('thread'), false);
    assert.equal(reads, 1);
  });
}

test('same-second completed host snapshot cannot end a different newly active turn', async () => {
  const project = path.resolve('host-project');
  const published: SessionInput[] = [];
  const adapter = createTestAgent({
    rpc: Object.assign(new EventEmitter(), {
      request: async (method: string) =>
        method === 'thread/read'
          ? {
              thread: {
                id: 'thread',
                cwd: project,
                updatedAt: 2000,
                turns: [{ id: 'old-turn', status: 'completed' }],
              },
            }
          : { data: [], nextCursor: null },
    }),
    client: {
      isAvailable: () => true,
      request: async (_: string, body: SessionInput) => published.push(body),
    },
    projects: [project],
    hostScope: true,
    lazyHistory: true,
    hostIndex: async () => ({
      projects: [],
      threads: [
        {
          id: 'thread',
          cwd: project,
          updatedAt: 2000,
          lastTurnStatus: 'completed',
          status: { type: 'notLoaded' },
        },
      ],
    }),
  });
  adapter.threads.set('thread', {
    id: 'thread',
    cwd: project,
    updatedAt: 2000,
    status: { type: 'active' },
    turns: [{ id: 'old-turn', status: 'completed' }],
  });
  adapter.activeTurns.set('thread', 'new-turn');
  adapter.streams.set('thread', 'New reply');
  await adapter.syncIndex();
  assert.equal(published.at(-1)!.session.status, 'running');
  assert.equal(adapter.activeTurns.get('thread'), 'new-turn');
  assert.equal(adapter.streams.get('thread'), 'New reply');
});

test('host index without lastTurnStatus verifies a terminal active turn before clearing cached state', async () => {
  const project = path.resolve('host-project');
  const published: SessionInput[] = [];
  const adapter = createTestAgent({
    rpc: Object.assign(new EventEmitter(), {
      request: async (method: string) =>
        method === 'thread/read'
          ? {
              thread: {
                id: 'thread',
                cwd: project,
                updatedAt: 2001,
                turns: [{ id: 'active-turn', status: 'completed' }],
              },
            }
          : { data: [], nextCursor: null },
    }),
    client: {
      isAvailable: () => true,
      request: async (_: string, body: SessionInput) => published.push(body),
    },
    projects: [project],
    hostScope: true,
    lazyHistory: true,
    hostIndex: async () => ({
      projects: [],
      threads: [{ id: 'thread', cwd: project, updatedAt: 2001, status: { type: 'notLoaded' } }],
    }),
  });
  adapter.threads.set('thread', {
    id: 'thread',
    cwd: project,
    updatedAt: 2000.8,
    status: { type: 'active' },
    turns: [{ id: 'active-turn', status: 'inProgress' }],
  });
  adapter.activeTurns.set('thread', 'active-turn');
  await adapter.syncIndex();
  assert.equal(published.at(-1)!.session.status, 'done');
  assert.equal(adapter.activeTurns.has('thread'), false);
});

for (const tracked of [true, false]) {
  test(`late turn completion preserves a new ${tracked ? 'tracked' : 'cached'} active turn and imports old items`, async () => {
    const project = path.resolve('host-project');
    const published: SessionInput[] = [];
    const events: EventInput[] = [];
    const adapter = createTestAgent({
      rpc: new EventEmitter(),
      client: {
        isAvailable: () => true,
        request: async (_: string, body: SessionInput) => published.push(body),
        event: async (_: string, type: string, fields: EventInput) =>
          events.push({ type, ...fields }),
      },
      projects: [project],
    });
    const thread = {
      id: 'thread',
      cwd: project,
      updatedAt: 2000.8,
      status: { type: 'active' },
      turns: [
        { id: 'old-turn', status: 'inProgress' },
        { id: 'new-turn', status: 'inProgress' },
      ],
    };
    adapter.threads.set('thread', thread);
    if (tracked) adapter.activeTurns.set('thread', 'new-turn');
    adapter.streams.set('thread', 'New reply');
    await adapter.publish(thread);
    await adapter.notification({
      method: 'turn/completed',
      params: {
        threadId: 'thread',
        turn: {
          id: 'old-turn',
          status: 'completed',
          items: [
            {
              id: 'old-output',
              type: 'agentMessage',
              text: 'Old final reply',
              phase: 'final_answer',
            },
          ],
        },
      },
    });
    assert.equal(adapter.state(thread), 'running');
    assert.equal(adapter.activeTurns.get('thread'), tracked ? 'new-turn' : undefined);
    assert.equal(adapter.streams.get('thread'), 'New reply');
    assert.equal(thread.status.type, 'active');
    assert.equal(thread.updatedAt, 2000.8);
    assert.equal(thread.turns.at(-1)!.id, 'new-turn');
    assert.equal(thread.turns[0].status, 'completed');
    assert.equal(
      events.some((event) => event.type === 'assistant.done'),
      false,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'message.assistant' &&
          event.turnId === 'old-turn' &&
          event.text === 'Old final reply',
      ),
    );
    assert.equal(published.length, 1);
    assert.equal(published.at(-1)!.session.status, 'running');

    await adapter.notification({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'new-turn', status: 'completed' } },
    });
    assert.equal(adapter.activeTurns.has('thread'), false);
    assert.equal(adapter.streams.has('thread'), false);
    assert.equal(published.at(-1)!.session.status, 'done');
    assert.equal(events.filter((event) => event.type === 'assistant.done').length, 1);
    assert.equal(events.at(-1)!.turnId, 'new-turn');
  });
}

test('legacy completion without a turn ID finishes the currently tracked turn', async () => {
  const project = path.resolve('host-project');
  const published: SessionInput[] = [];
  const events: EventInput[] = [];
  const adapter = createTestAgent({
    rpc: new EventEmitter(),
    client: {
      isAvailable: () => true,
      request: async (_: string, body: SessionInput) => published.push(body),
      event: async (_: string, type: string, fields: EventInput) =>
        events.push({ type, ...fields }),
    },
    projects: [project],
  });
  adapter.threads.set('thread', {
    id: 'thread',
    cwd: project,
    updatedAt: 2000.8,
    status: { type: 'active' },
    turns: [{ id: 'active-turn', status: 'inProgress' }],
  });
  adapter.activeTurns.set('thread', 'active-turn');
  adapter.streams.set('thread', 'Processing');
  await adapter.notification({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { status: 'completed' } as CodexTurn },
  });
  assert.equal(adapter.activeTurns.has('thread'), false);
  assert.equal(adapter.streams.has('thread'), false);
  assert.equal(adapter.threads.get('thread')!.turns!.at(-1)!.id, 'active-turn');
  assert.equal(published.at(-1)!.session.status, 'done');
  assert.equal(events.at(-1)!.type, 'assistant.done');
  assert.equal(events.at(-1)!.turnId, 'active-turn');
});
