import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'node:http';
import { AgentClient } from '../sdk/agent-client.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const token = 'integration-test-only';
const localSessionId = '11111111-1111-4111-8111-111111111111';
let directory, server, origin;
let output = '';
const children = new Set();

async function startServer() {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AUTH_TOKEN: token, AGENT_TOKEN: token,
      DB_PATH: path.join(directory, 'test.db'), LOCAL_CLAUDE: '1',
      CLAUDE_PROJECTS_DIR: path.join(directory, 'claude'), AGENT_OFFLINE_MS: '1500', AGENT_COMMAND_TIMEOUT_MS: '1200' },
  });
  children.add(server);
  output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  await until(() => /listening on 127.0.0.1:(\d+)/.test(output), 10000);
  origin = `http://127.0.0.1:${output.match(/listening on 127.0.0.1:(\d+)/)[1]}`;
}

async function stopServer() {
  const exit = once(server, 'exit');
  server.kill();
  await exit;
  children.delete(server);
}

async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out\n${output}`);
}

async function request(endpoint, { body, auth = token, status = 200 } = {}) {
  const response = await fetch(origin + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${endpoint}: ${JSON.stringify(data)}`);
  return data;
}

async function register(key, capabilities = ['message.send', 'session.stop', 'session.start', 'approval.respond']) {
  return request('/agent/register', { status: 201, body: { nodeId: `host-${key}`, nodeName: `Host ${key}`,
    agentKey: key, name: `Agent ${key}`, provider: 'custom', capabilities } });
}

const publish = (agent, id = 'shared-session') => request('/agent/sessions', { auth: agent.token, body: {
  project: { id: 'shared-project', name: 'Shared project', cwd: '/same/path' },
  session: { id, summary: 'Test task', status: 'running' },
} });

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-platform-test-'));
  const projectDir = path.join(directory, 'claude', 'fixture-project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, `${localSessionId}.jsonl`), JSON.stringify({
    type: 'user', uuid: 'fixture-message', sessionId: localSessionId, cwd: '/fixture/project',
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'Fixture conversation' },
  }) + '\n');
  await startServer();
});

after(async () => {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  }
  const base = path.resolve(os.tmpdir()) + path.sep;
  if (directory && path.resolve(directory).startsWith(base) && path.basename(directory).startsWith('xiaomeng-platform-test-')) {
    await rm(directory, { recursive: true, force: true });
  }
});

test('LAN platform isolates sources and routes operations with receipts', async (t) => {
  const a = await register('alpha');
  const b = await register('beta', []);
  const sa = await publish(a);
  const sb = await publish(b);

  await t.test('local Claude sessions remain readable alongside separate remote identities', async () => {
    assert.notEqual(sa.projectId, sb.projectId);
    assert.notEqual(sa.sessionId, sb.sessionId);
    const projects = await request('/api/projects');
    assert.equal(projects.length, 3);
    assert.equal(projects.find((p) => p.projectId === sa.projectId).agentName, 'Agent alpha');
    assert.equal(projects.find((p) => p.projectId === 'fixture-project').agentId, 'local-claude');
    const events = await request(`/api/sessions/${localSessionId}/events`);
    assert.ok(events.some((e) => e.detail === 'Fixture conversation'));
    await request('/api/projects/..%5Coutside/sessions', { status: 400 });
    await request('/api/sessions/unknown/message', { body: { text: 'never spawn' }, status: 404 });
  });

  await t.test('tokens separate dashboard, enrollment and agent access', async () => {
    await request('/api/agents', { auth: a.token, status: 401 });
    await request('/agent/commands', { auth: token, status: 401 });
    await request('/agent/register', { auth: 'wrong', body: {}, status: 401 });
    await request('/agent/register', { body: { nodeId: 'host-alpha', nodeName: 'Spoof', agentKey: 'alpha', name: 'Spoof', provider: 'custom' }, status: 409 });
    await request('/agent/events', { auth: b.token, body: { sessionId: sa.sessionId, eventId: 'x', type: 'message.assistant', text: 'wrong owner' }, status: 404 });
  });

  await t.test('legacy Claude permission hooks still return an actual decision', async () => {
    const gate = fetch(`${origin}/hooks/gate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: localSessionId,
        cwd: '/fixture/project', tool_name: 'Bash', tool_input: { command: 'echo fixture' } }),
      signal: AbortSignal.timeout(5000),
    }).then((response) => response.json());
    const approval = await until(async () => (await request('/api/approvals')).find((a) => a.sessionId === localSessionId));
    await request(`/api/approvals/${approval.approvalId}`, { body: { decision: 'reject', scope: 'once' } });
    assert.equal((await gate).hookSpecificOutput.decision.behavior, 'deny');
  });

  await t.test('durable events deduplicate and survive history reload', async () => {
    const body = { sessionId: 'shared-session', eventId: 'reply-1', type: 'message.assistant', text: 'Hello from alpha', phase: 'final_answer', turnId: 'turn', itemId: 'answer' };
    await request('/agent/events', { auth: a.token, body });
    assert.equal((await request('/agent/events', { auth: a.token, body })).duplicate, true);
    const events = await request(`/api/sessions/${sa.sessionId}/events`);
    assert.equal(events.length, 1);
    assert.equal(events[0].detail, 'Hello from alpha');
    assert.equal(events[0].phase, 'final_answer');
    assert.equal(events[0].turn_id, 'turn');
    assert.equal(events[0].item_id, 'answer');
    assert.deepEqual(await request(`/api/sessions/${sb.sessionId}/events`), []);
    await request('/agent/events', { auth: a.token, body: { ...body, type: 'unknown' }, status: 400 });
  });

  await t.test('capabilities, ownership and request IDs control message delivery', async () => {
    await request(`/api/sessions/${sb.sessionId}/message`, { body: { text: 'not allowed' }, status: 409 });
    await request('/agent/heartbeat', { auth: a.token, body: {} });
    const body = { text: 'continue', requestId: 'send-1' };
    const command = await request(`/api/sessions/${sa.sessionId}/message`, { body, status: 202 });
    assert.equal((await request(`/api/sessions/${sa.sessionId}/message`, { body, status: 202 })).commandId, command.commandId);
    await request(`/api/sessions/${sa.sessionId}/message`, { body: { ...body, text: 'different' }, status: 409 });
    assert.deepEqual(await request('/agent/commands', { auth: b.token }), []);
    const [delivery] = await request('/agent/commands', { auth: a.token });
    assert.equal(delivery.type, 'message.send');
    assert.equal(delivery.payload.sessionId, 'shared-session');
    assert.deepEqual(await request('/agent/commands', { auth: a.token }), []);
    await request(`/agent/commands/${command.commandId}/result`, { auth: b.token, body: { ok: true }, status: 404 });
    await request(`/agent/commands/${command.commandId}/result`, { auth: a.token, body: { ok: true } });
    assert.equal((await request(`/api/commands/${command.commandId}`)).status, 'succeeded');
    assert.equal((await request(`/agent/commands/${command.commandId}/result`, { auth: a.token, body: { ok: false } })).status, 'succeeded');
  });

  await t.test('approvals remain pending until the correct agent confirms', async () => {
    const approval = await request('/agent/approvals', { auth: a.token, body: { id: 'approval-1', sessionId: 'shared-session', title: 'Proceed?', command: 'demo', ttlMs: 30000 } });
    await request(`/api/approvals/${approval.approvalId}`, { body: { decision: 'approve', scope: 'always' }, status: 400 });
    const queued = await request(`/api/approvals/${approval.approvalId}`, { body: { decision: 'approve' } });
    assert.ok((await request('/api/approvals')).some((x) => x.approvalId === approval.approvalId));
    await request('/agent/commands', { auth: a.token });
    await request(`/agent/commands/${queued.commandId}/result`, { auth: a.token, body: { ok: true } });
    assert.ok(!(await request('/api/approvals')).some((x) => x.approvalId === approval.approvalId));
  });

  await t.test('new sessions and stop route to remote IDs', async () => {
    const body = { text: 'new task', requestId: 'start-1' };
    const created = await request(`/api/projects/${sa.projectId}/sessions`, { body, status: 202 });
    assert.equal((await request(`/api/projects/${sa.projectId}/sessions`, { body, status: 202 })).sessionId, created.sessionId);
    const commands = await request('/agent/commands', { auth: a.token });
    assert.equal(commands[0].type, 'session.start');
    await request(`/agent/commands/${created.commandId}/result`, { auth: a.token, body: { ok: false, error: 'Start refused' } });
    const stop = await request(`/api/sessions/${sa.sessionId}/control`, { body: { action: 'stop' }, status: 202 });
    const [command] = await request('/agent/commands', { auth: a.token });
    assert.equal(command.type, 'session.stop');
    await request(`/agent/commands/${stop.commandId}/result`, { auth: a.token, body: { ok: true } });
    await request(`/api/sessions/${sa.sessionId}/control`, { body: { action: 'delete' }, status: 400 });
  });

  await t.test('agent-side approval completion cancels an undelivered decision', async () => {
    const approval = await request('/agent/approvals', { auth: a.token, body: { id: 'approval-cancel', sessionId: 'shared-session', title: 'Cancel test' } });
    const command = await request(`/api/approvals/${approval.approvalId}`, { body: { decision: 'approve' } });
    await request('/agent/approvals/approval-cancel/resolve', { auth: b.token, body: { status: 'expired' }, status: 404 });
    await request('/agent/approvals/approval-cancel/resolve', { auth: a.token, body: { status: 'expired' } });
    assert.equal((await request(`/api/commands/${command.commandId}`)).status, 'failed');
    assert.deepEqual(await request('/agent/commands', { auth: a.token }), []);
  });

  await t.test('approval deadline also limits command delivery', async () => {
    const approval = await request('/agent/approvals', { auth: a.token, body: { id: 'approval-expire', sessionId: 'shared-session', title: 'Expire test', ttlMs: 1000 } });
    const command = await request(`/api/approvals/${approval.approvalId}`, { body: { decision: 'approve' } });
    assert.ok(command.expiresAt <= approval.expiresAt);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.deepEqual(await request('/agent/commands', { auth: a.token }), []);
    assert.ok(!(await request('/api/approvals')).some((x) => x.approvalId === approval.approvalId));
  });

  await t.test('WebSocket snapshots and errors use the generic protocol', async () => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + `/ws?token=${token}`);
    const messages = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw)));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'message.send', sessionId: sb.sessionId, text: 'blocked' }));
    try {
      await until(() => messages.some((m) => m.type === 'agents.snapshot'));
      await request('/agent/events', { auth: a.token, body: { sessionId: 'shared-session', type: 'assistant.delta', text: 'Reading files', phase: 'commentary', turnId: 'turn', itemId: 'progress' } });
      await until(() => messages.some((m) => m.type === 'assistant.delta'));
      const delta = messages.find((m) => m.type === 'assistant.delta');
      assert.equal(delta.phase, 'commentary');
      assert.equal(delta.turnId, 'turn');
      assert.equal(delta.itemId, 'progress');
      assert.ok(messages.find((m) => m.type === 'agents.snapshot').agents.some((agent) => agent.agentId === 'local-claude'));
      await until(() => messages.some((m) => m.type === 'command.error'));
      await request('/agent/heartbeat', { auth: a.token, body: {} });
      socket.send(JSON.stringify({ type: 'message.send', sessionId: sa.sessionId, text: 'via ws' }));
      await until(() => messages.some((m) => m.type === 'command.accepted'));
      const [command] = await request('/agent/commands', { auth: a.token });
      await request(`/agent/commands/${command.commandId}/result`, { auth: a.token, body: { ok: true } });
      await until(() => messages.some((m) => m.type === 'command.result'));
      assert.equal(messages.find((m) => m.type === 'command.result').operation, 'message.send');
    } finally { socket.close(); }
  });

  await t.test('disconnected sources reject controls and unreceived commands expire', async () => {
    await request('/agent/heartbeat', { auth: a.token, body: {} });
    const queued = await request(`/api/sessions/${sa.sessionId}/message`, { body: { text: 'expires' }, status: 202 });
    await until(async () => (await request('/api/agents')).find((x) => x.agentId === a.agentId).online === false);
    await request(`/api/sessions/${sa.sessionId}/message`, { body: { text: 'offline' }, status: 409 });
    assert.equal((await request(`/api/commands/${queued.commandId}`)).status, 'failed');
    assert.deepEqual(await request('/agent/commands', { auth: a.token }), []);
  });

  await t.test('hub restart preserves data and never re-delivers uncertain commands', async () => {
    const queued = await request(`/api/sessions/${sa.sessionId}/message`, { body: { text: 'in flight' }, status: 202 });
    await request('/agent/commands', { auth: a.token });
    await stopServer();
    await startServer();
    assert.equal((await request(`/api/commands/${queued.commandId}`)).status, 'failed');
    assert.deepEqual(await request('/agent/commands', { auth: a.token }), []);
    assert.ok((await request(`/api/sessions/${sa.sessionId}/events`)).some((e) => e.detail === 'Hello from alpha'));
  });
});

test('SDK registers, polls, publishes replies and reuses persisted credentials', async () => {
  const stateFile = path.join(directory, 'sdk.json');
  let client;
  client = new AgentClient({ hubUrl: origin, enrollmentToken: token, nodeId: 'sdk-node', nodeName: 'SDK host',
    agentKey: 'sdk', name: 'SDK agent', stateFile, onError: () => {}, handlers: {
      'message.send': async ({ sessionId, text }) => {
        await client.event(sessionId, 'message.assistant', { text: `Reply: ${text}` });
        await client.event(sessionId, 'assistant.done', { ok: true });
      },
    },
  });
  await client.connect();
  try {
    const session = await client.session({ id: 'sdk-project', name: 'SDK' }, { id: 'sdk-session', status: 'waiting_input' });
    await until(() => client.streamConnected);
    const started = Date.now();
    const command = await request(`/api/sessions/${session.sessionId}/message`, { body: { text: 'hello SDK' }, status: 202 });
    await until(async () => (await request(`/api/commands/${command.commandId}`)).status === 'succeeded');
    assert.ok(Date.now() - started < 700, 'SSE should wake the agent before its polling interval');
    assert.equal((await request(`/api/sessions/${session.sessionId}/events`))[0].detail, 'Reply: hello SDK');
  } finally { await client.close(); }
  const restored = new AgentClient({ hubUrl: origin, stateFile, nodeId: 'sdk-node', agentKey: 'sdk', name: 'SDK agent' });
  await restored.connect();
  assert.equal(restored.credentials.agentId, client.credentials.agentId);
  await restored.close();
});

test('local Claude settings validate host model choices and publish next-turn metadata', async () => {
  const catalog = await request(`/api/agents/local-claude/catalog?sessionId=${localSessionId}`);
  assert.ok(catalog.models.some((model) => model.id === 'sonnet'));
  await request(`/api/sessions/${localSessionId}/configure`, { status: 400, body: { settings: { model: 'sonnet & echo bad' } } });
  await request(`/api/sessions/${localSessionId}/configure`, { status: 400, body: { settings: { mode: 'bypassPermissions' } } });
  const result = await request(`/api/sessions/${localSessionId}/configure`, { body: { settings: { model: 'sonnet', reasoningEffort: 'high', mode: 'plan' } } });
  assert.equal(result.appliesTo, 'next_turn');
  assert.equal(result.confirmed, true);
  const project = (await request('/api/projects')).find((p) => p.agentId === 'local-claude');
  assert.equal(project.sessions[0].model, 'sonnet');
  assert.equal((await request(`/api/projects/${project.projectId}/sessions`))[0].reasoningEffort, 'high');
});

test('demo agent completes a real approval round trip without model calls', async () => {
  const child = spawn(process.execPath, ['scripts/demo-agent.mjs'], { cwd: root, windowsHide: true,
    env: { ...process.env, HUB_URL: origin, HUB_TOKEN: token, NODE_ID: 'demo-test', AGENT_KEY: 'demo-test',
      AGENT_STATE_FILE: path.join(directory, 'demo.json') },
  });
  children.add(child);
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  try {
    const project = await until(async () => (await request('/api/projects')).find((p) => p.nodeId === 'demo-test'));
    const sent = await request(`/api/sessions/${project.activeSessionId}/message`, { body: { text: 'hello /approve' }, status: 202 });
    const approval = await until(async () => (await request('/api/approvals')).find((a) => a.projectId === project.projectId));
    await request(`/api/approvals/${approval.approvalId}`, { body: { decision: 'approve' } });
    await until(async () => (await request('/api/projects')).find((p) => p.projectId === project.projectId).status === 'done', 10000);
    assert.equal((await request(`/api/commands/${sent.commandId}`)).status, 'succeeded', log);
    assert.ok((await request(`/api/sessions/${project.activeSessionId}/events`)).some((e) => e.hook_event_name === 'AssistantText'));
  } finally {
    const exit = once(child, 'exit'); child.kill(); await exit; children.delete(child);
  }
});

test('Claude relay mirrors a separate bridge and routes its operations', async () => {
  const received = [];
  let approvalPending = true;
  const sourceProject = { agentId: 'local-claude', projectId: 'relay-repo', name: 'Relay repository', cwd: '/relay',
    activeSessionId: 'relay-session', status: 'done', sessions: [{ session_id: 'relay-session', summary: 'Relay task', status: 'done', updated_at: Date.now() }] };
  const bridge = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      received.push({ path: req.url, body: JSON.parse(raw) });
      if (req.url.includes('/approvals/')) { approvalPending = false; res.end(JSON.stringify({ ok: true, status: 'approved' })); }
      else res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/api/projects') res.end(JSON.stringify([sourceProject]));
    else if (req.url === '/api/approvals') res.end(JSON.stringify(approvalPending ? [{ approvalId: 'relay-approval', sessionId: 'relay-session', kind: 'command', title: 'Relay approval', command: 'echo fixture', expiresAt: Date.now() + 30000 }] : []));
    else if (req.url === '/api/sessions/relay-session/events') res.end(JSON.stringify([{ id: 1, hook_event_name: 'AssistantText', detail: 'History from bridge', created_at: 1000 }]));
    else { res.statusCode = 404; res.end('{}'); }
  });
  const wss = new WebSocketServer({ server: bridge, path: '/ws' });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  const child = spawn(process.execPath, ['scripts/connect-hub.mjs'], { cwd: root, windowsHide: true,
    env: { ...process.env, HUB_URL: origin, HUB_TOKEN: token, NODE_ID: 'relay-test', AGENT_KEY: 'relay-test',
      AGENT_STATE_FILE: path.join(directory, 'relay.json'), BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`, BRIDGE_TOKEN: token },
  });
  children.add(child);
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  try {
    const project = await until(async () => (await request('/api/projects')).find((p) => p.nodeId === 'relay-test'));
    await until(async () => (await request(`/api/sessions/${project.activeSessionId}/events`)).some((e) => e.detail === 'History from bridge'));
    const sent = await request(`/api/sessions/${project.activeSessionId}/message`, { body: { text: 'forward me' }, status: 202 });
    await until(async () => (await request(`/api/commands/${sent.commandId}`)).status === 'succeeded');
    assert.ok(received.some((r) => r.path === '/api/sessions/relay-session/message' && r.body.text === 'forward me'), log);
    const approval = await until(async () => (await request('/api/approvals')).find((a) => a.projectId === project.projectId));
    const approved = await request(`/api/approvals/${approval.approvalId}`, { body: { decision: 'approve' } });
    await until(async () => (await request(`/api/commands/${approved.commandId}`)).status === 'succeeded');
    assert.ok(received.some((r) => r.path === '/api/approvals/relay-approval' && r.body.decision === 'approve'));
    const stopped = await request(`/api/sessions/${project.activeSessionId}/control`, { body: { action: 'stop' }, status: 202 });
    await until(async () => (await request(`/api/commands/${stopped.commandId}`)).status === 'succeeded');
    assert.ok(received.some((r) => r.body.action === 'stop'));
    await request(`/api/sessions/${project.activeSessionId}/configure`, { body: { settings: { model: 'sonnet', reasoningEffort: 'high' } } });
    assert.ok(received.some((r) => r.path === '/api/sessions/relay-session/configure' && r.body.settings.model === 'sonnet'));
    assert.equal(project.capabilities.includes('session.start'), false);
  } finally {
    const exit = once(child, 'exit'); child.kill(); await exit; children.delete(child);
    for (const client of wss.clients) client.terminate();
    wss.close();
    bridge.closeAllConnections();
    await new Promise((resolve) => bridge.close(resolve));
  }
});
