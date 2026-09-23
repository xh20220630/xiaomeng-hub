import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import { CodexDesktop, desktopTurns, applyDesktopPatches } from '../sdk/codex-desktop.mjs';
import { CodexAgent } from '../sdk/codex-agent.mjs';

function frame(value) {
  const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}

async function fixture(t) {
  const received = [], sockets = new Set();
  let revision = 1;
  const state = { id: 'desktop-task', cwd: process.cwd(), title: 'Desktop task', updatedAt: Date.now(),
    threadRuntimeStatus: { type: 'active' }, latestModel: 'host-model', latestThreadSettings: { model: 'host-model', effort: 'high' },
    turns: [{ turnId: 'active-turn', status: 'inProgress', items: [{ id: 'reply', type: 'agentMessage', text: 'Live text', phase: 'commentary' }] }], requests: [] };
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length); received.push(message);
        const publish = () => socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
          sourceClientId: 'desktop-owner', params: { hostId: 'local', conversationId: state.id,
            change: { type: 'snapshot', revision: revision++, conversationState: state } } }));
        if (message.type === 'broadcast' && message.params.following) { publish(); continue; }
        if (message.type !== 'request') continue;
        const reply = { type: 'response', requestId: message.requestId, resultType: 'success', handledByClientId: 'desktop-owner', result: {} };
        if (message.method === 'initialize') reply.result = { clientId: 'remote-client' };
        else if (message.method === 'thread-owner-discovery' && message.params.conversationId !== state.id) { reply.resultType = 'error'; reply.error = 'no-client-found'; }
        else if (message.method === 'thread-follower-update-thread-settings') { state.latestThreadSettings = { ...state.latestThreadSettings, ...message.params.threadSettings }; publish(); }
        else if (message.method === 'thread-follower-interrupt-turn') { state.turns[0].status = 'interrupted'; state.threadRuntimeStatus = { type: 'idle' }; publish(); }
        const bytes = frame(reply);
        socket.write(bytes.subarray(0, 3)); socket.write(bytes.subarray(3));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const desktop = new CodexDesktop({ endpoint: { port: server.address().port, host: '127.0.0.1' }, timeoutMs: 1000 });
  t.after(async () => { desktop.close(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return { desktop, received, state };
}

test('desktop IPC discovers owner, handles fragmented frames and guards stream revisions', async (t) => {
  const { desktop, received } = await fixture(t);
  assert.equal(await desktop.follow('missing'), false);
  assert.equal(await desktop.follow('desktop-task'), true);
  const state = await desktop.state('desktop-task');
  assert.equal(desktopTurns(state)[0].status, 'inProgress');
  const broadcast = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop-owner',
    params: { hostId: 'local', conversationId: 'desktop-task', change: { type: 'patches', baseRevision: 1, revision: 2,
      patches: [{ op: 'replace', path: ['latestModel'], value: 'changed-model' }] } } };
  desktop.message({ ...broadcast, sourceClientId: 'other-owner' });
  assert.equal(state.latestModel, 'host-model');
  desktop.message(broadcast);
  assert.equal(state.latestModel, 'changed-model');
  desktop.message(broadcast);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(received.some((r) => r.type === 'broadcast' && r.params.following === false));
  const warning = once(desktop, 'warning'); desktop.message({ ...broadcast, version: 999 });
  assert.match((await warning)[0].message, /协议版本/);
  assert.equal(desktop.has('desktop-task'), false);
});

test('remote settings, steer and stop target the desktop owner without resuming a second writer', async (t) => {
  const { desktop, received } = await fixture(t);
  const rpc = new EventEmitter(); rpc.url = null;
  const calls = [];
  rpc.request = async (method) => { calls.push(method); if (method === 'model/list') return { data: [{ model: 'host-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }; throw new Error(`Unexpected RPC: ${method}`); };
  const events = [];
  const client = { isAvailable: () => true, request: async () => {}, event: async (_, type, fields) => events.push({ type, ...fields }), resolveApproval: async () => {} };
  const adapter = new CodexAgent({ rpc, client, desktop, projects: [process.cwd()], onError: (e) => { throw e; } });
  t.after(() => adapter.desktop.close());
  adapter.threads.set('desktop-task', { id: 'desktop-task', cwd: process.cwd(), status: { type: 'active' }, canAcceptDirectInput: false });
  await desktop.follow('desktop-task'); await desktop.state('desktop-task');
  await adapter.desktop.project('desktop-task');
  const delta = events.find((event) => event.type === 'assistant.delta');
  assert.equal(delta.phase, 'commentary');
  assert.equal(delta.itemId, 'reply');
  assert.equal(delta.turnId, 'active-turn');
  const result = await adapter.configure({ sessionId: 'desktop-task', settings: { model: 'host-model', reasoningEffort: 'high' } });
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
    { op: 'add', path: ['items', 1], value: 'b' }, { op: 'remove', path: ['items', 0] },
  ]);
  assert.deepEqual(state.items, ['b', 'c']);
  assert.throws(() => applyDesktopPatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]));
  assert.equal({}.polluted, undefined);
});
