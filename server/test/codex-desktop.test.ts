/** 验证Codex 桌面通信，使用隔离的测试资源。 */
import type { TestContext } from 'node:test';
import type { DesktopReply, DesktopBroadcast } from '../src/types/codex.js';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import {
  CodexDesktop,
  desktopTurns,
  applyDesktopPatches,
} from '../src/adapters/codex/codex-desktop.js';
import { createTestAgent } from './fixtures/agent.js';
import type { EventInput } from '../src/types/domain.js';

/**
 * 按桌面 IPC 格式加上长度头，用于测试拆包行为。
 * @param value 需要校验、散列或转换的输入值。
 * @returns 完整测试帧。
 */
function frame(value: unknown) {
  const data = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}

/**
 * 建立隔离的桌面模拟服务，并注册连接与端口清理。
 * @param t 当前测试上下文，负责注册资源清理。
 * @returns 测试端点及捕获到的请求。
 */
async function fixture(t: TestContext) {
  const received: {
      /** 决定负载解释方式的协议类别。 */
      type: string;
      /** 需要调用或已收到的协议方法。 */
      method?: string;
      /** 实际处理操作的桌面拥有者。 */
      targetClientId?: string;
      /** 与方法名对应的结构化参数。 */
      params: {
        /** 是否订阅目标会话的状态流。 */
        following?: boolean;
        /** 本次用户指令的内容块。 */
        input: {
          /** 可直接展示的文本内容。 */
          text: string;
        }[];
        /** 提交操作时必须匹配的活动轮次。 */
        expectedTurnId?: string;
      };
    }[] = [],
    sockets = new Set<net.Socket>();
  let revision = 1;
  const state = {
    id: 'desktop-task',
    cwd: process.cwd(),
    title: 'Desktop task',
    updatedAt: Date.now(),
    threadRuntimeStatus: { type: 'active' },
    latestModel: 'host-model',
    latestThreadSettings: { model: 'host-model', effort: 'high' },
    turns: [
      {
        turnId: 'active-turn',
        status: 'inProgress',
        items: [{ id: 'reply', type: 'agentMessage', text: 'Live text', phase: 'commentary' }],
      },
    ],
    requests: [],
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0),
          message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
        buffer = buffer.subarray(4 + length);
        received.push(message);
        /**
         * 发布模拟主机状态，使测试走真实的同步和控制逻辑。
         * @returns 状态发布结果。
         */
        const publish = () =>
          socket.write(
            frame({
              type: 'broadcast',
              method: 'thread-stream-state-changed',
              version: 11,
              sourceClientId: 'desktop-owner',
              params: {
                hostId: 'local',
                conversationId: state.id,
                change: { type: 'snapshot', revision: revision++, conversationState: state },
              },
            }),
          );
        if (message.type === 'broadcast' && message.params.following) {
          publish();
          continue;
        }
        if (message.type !== 'request') continue;
        const reply: DesktopReply & {
          /** 决定负载解释方式的协议类别。 */
          type: string;
        } = {
          type: 'response',
          requestId: message.requestId,
          resultType: 'success',
          handledByClientId: 'desktop-owner',
          result: {},
        };
        if (message.method === 'initialize') reply.result = { clientId: 'remote-client' };
        else if (
          message.method === 'thread-owner-discovery' &&
          message.params.conversationId !== state.id
        ) {
          reply.resultType = 'error';
          reply.error = 'no-client-found';
        } else if (message.method === 'thread-follower-update-thread-settings') {
          state.latestThreadSettings = {
            ...state.latestThreadSettings,
            ...message.params.threadSettings,
          };
          publish();
        } else if (message.method === 'thread-follower-interrupt-turn') {
          state.turns[0].status = 'interrupted';
          state.threadRuntimeStatus = { type: 'idle' };
          publish();
        }
        const bytes = frame(reply);
        socket.write(bytes.subarray(0, 3));
        socket.write(bytes.subarray(3));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const desktop = new CodexDesktop({
    endpoint: { port: (server.address() as AddressInfo).port, host: '127.0.0.1' },
    timeoutMs: 1000,
  });
  t.after(async () => {
    desktop.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { desktop, received, state };
}

test('desktop IPC discovers owner, handles fragmented frames and guards stream revisions', async (t) => {
  const { desktop, received } = await fixture(t);
  assert.equal(await desktop.follow('missing'), false);
  assert.equal(await desktop.follow('desktop-task'), true);
  const state = await desktop.state('desktop-task');
  assert.equal(desktopTurns(state)[0].status, 'inProgress');
  const broadcast: DesktopBroadcast = {
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    version: 11,
    sourceClientId: 'desktop-owner',
    params: {
      hostId: 'local',
      conversationId: 'desktop-task',
      change: {
        type: 'patches',
        baseRevision: 1,
        revision: 2,
        patches: [{ op: 'replace', path: ['latestModel'], value: 'changed-model' }],
      },
    },
  };
  desktop.message({ ...broadcast, sourceClientId: 'other-owner' });
  assert.equal(state.latestModel, 'host-model');
  desktop.message(broadcast);
  assert.equal(state.latestModel, 'changed-model');
  desktop.message(broadcast);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(received.some((r) => r.type === 'broadcast' && r.params.following === false));
  const warning = once(desktop, 'warning');
  desktop.message({ ...broadcast, version: 999 });
  assert.match((await warning)[0].message, /协议版本/);
  assert.equal(desktop.has('desktop-task'), false);
});

test('remote settings, steer and stop target the desktop owner without resuming a second writer', async (t) => {
  const { desktop, received } = await fixture(t);
  const rpc: EventEmitter & {
    /** 目标服务或资源地址。 */
    url?: string;
    /** 测试替换的协议请求方法。 */
    request?: (method: string) => Promise<unknown>;
  } = new EventEmitter();
  const calls: string[] = [];
  rpc.request = async (method) => {
    calls.push(method);
    if (method === 'model/list')
      return {
        data: [{ model: 'host-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
      };
    throw new Error(`Unexpected RPC: ${method}`);
  };
  const events: EventInput[] = [];
  const client = {
    isAvailable: () => true,
    request: async () => {},
    event: async (_: string, type: string, fields: EventInput) => events.push({ type, ...fields }),
    resolveApproval: async () => {},
  };
  const adapter = createTestAgent({
    rpc,
    client,
    desktop,
    projects: [process.cwd()],
    onError: (e: Error) => {
      throw e;
    },
  });
  t.after(() => adapter.desktop!.close());
  adapter.threads.set('desktop-task', {
    id: 'desktop-task',
    cwd: process.cwd(),
    status: { type: 'active' },
    canAcceptDirectInput: false,
  });
  await desktop.follow('desktop-task');
  await desktop.state('desktop-task');
  await adapter.desktop!.project('desktop-task');
  const delta = events.find((event) => event.type === 'assistant.delta');
  assert.equal(delta!.phase, 'commentary');
  assert.equal(delta!.itemId, 'reply');
  assert.equal(delta!.turnId, 'active-turn');
  const result = await adapter.configure({
    sessionId: 'desktop-task',
    settings: { model: 'host-model', reasoningEffort: 'high' },
  });
  assert.equal(result.confirmed, true);
  await adapter.steer({ sessionId: 'desktop-task', text: 'Continue with this instruction' });
  await adapter.stop({ sessionId: 'desktop-task' });
  const writes = received.filter((r) => r.method?.startsWith('thread-follower-'));
  assert.equal(writes.length, 3);
  assert.ok(writes.every((r) => r.targetClientId === 'desktop-owner'));
  assert.equal(writes[1].params.input[0].text, 'Continue with this instruction');
  assert.equal(writes[2].params.expectedTurnId, 'active-turn');
  assert.deepEqual(calls, ['model/list']);
  await adapter.serial;
});

test('desktop patches insert arrays, remove values and reject prototype paths', () => {
  const state = applyDesktopPatches({ items: ['a', 'c'] }, [
    { op: 'add', path: ['items', 1], value: 'b' },
    { op: 'remove', path: ['items', 0] },
  ]);
  assert.deepEqual(state.items, ['b', 'c']);
  assert.throws(() =>
    applyDesktopPatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]),
  );
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
