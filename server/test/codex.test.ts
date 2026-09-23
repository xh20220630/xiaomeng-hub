/** 验证Codex 操作和审批，使用隔离的测试资源。 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SessionView, ApprovalView, TaskEvent, ProjectView } from '../src/types/domain.js';
import type { AddressInfo } from 'node:net';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CodexRpc } from '../src/adapters/codex/codex-rpc.js';
import { CodexAgent } from '../src/adapters/codex/codex-agent.js';
import { AgentClient } from '../src/sdk/agent-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let directory: string,
  server: ChildProcessWithoutNullStreams,
  origin: string,
  adapter: CodexAgent,
  client: AgentClient,
  projectId: string;
let logs = '';
const errors: string[] = [];
const token = 'codex-fixture-only';
/**
 * 有界等待异步状态达到预期，超时输出测试日志。
 * @param check 返回目标状态的同步或异步检测函数。
 * @param timeout 等待测试条件满足的最大毫秒数。
 * @returns 首次满足条件的值。
 */
async function until<T>(check: () => T | Promise<T>, timeout = 12000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${logs}\n${errors.join('\n')}`);
}
/**
 * 向隔离测试中心发送 API 请求并验证响应状态。
 * @param endpoint 请求路径或本机 IPC 端点。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @param expected 测试断言期望的 HTTP 状态码。
 * @returns 解码后的测试响应。
 */
async function api(endpoint: string, body?: unknown, expected = 200) {
  const result = await fetch(`${origin}/api${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await result.json();
  assert.equal(result.status, expected, JSON.stringify(data));
  return data;
}
/**
 * 等待操作进入最终状态，避免把受理结果当执行结果。
 * @param id 待处理实体的稳定标识。
 * @returns 最终命令回执。
 */
const receipt = (id: string) =>
  until(async () => {
    const result = await api(`/commands/${id}`);
    return ['succeeded', 'failed'].includes(result.status) ? result : false;
  });
/**
 * 将主机项目和会话摘要上报给中心。
 * @param id 待处理实体的稳定标识。
 * @returns 中心分配的项目和会话标识。
 */
const session = (id: string) =>
  until(async () =>
    (await api(`/projects/${projectId}/sessions`)).find((s: SessionView) => s.session_id === id),
  );
/**
 * 启动隔离测试宿主机或会话，等待真实就绪信号。
 * @param text 用户指令、输出或待处理文本。
 * @returns 可用于后续断言的已就绪状态。
 */
async function start(text: string) {
  const result = await api(`/projects/${projectId}/sessions`, { text }, 202);
  assert.equal((await receipt(result.commandId)).status, 'succeeded');
  return result.sessionId;
}
/**
 * 创建有明确有效期限的远程审批请求。
 * @param sid 测试或示例中的会话标识。
 * @returns 中心审批信息。
 */
const approval = (sid: string) =>
  until(async () => (await api('/approvals')).find((a: ApprovalView) => a.sessionId === sid));

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-codex-test-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      AUTH_TOKEN: token,
      AGENT_TOKEN: token,
      LOCAL_CLAUDE: '0',
      DB_PATH: path.join(directory, 'db.sqlite'),
    },
  });
  server.stdout.on('data', (data) => {
    logs += data;
  });
  server.stderr.on('data', (data) => {
    logs += data;
  });
  await until(() => /listening on 127.0.0.1:(\d+)/.test(logs));
  origin = `http://127.0.0.1:${logs.match(/listening on 127.0.0.1:(\d+)/)![1]}`;
  const rpc = new CodexRpc({
    command: [process.execPath, []],
    args: [path.join(root, 'test/fixtures/codex-app-server.js')],
    env: { ...process.env, FIXTURE_PROJECT: project },
  });
  client = new AgentClient({
    hubUrl: origin,
    enrollmentToken: token,
    agentKey: 'codex-test',
    name: 'Codex Fixture',
    provider: 'codex',
    stateFile: path.join(directory, 'credentials.json'),
    isAvailable: () => rpc.ready,
    onError: (e) => errors.push(e.message),
  });
  adapter = new CodexAgent({
    rpc,
    client,
    projects: [project],
    stateFile: path.join(directory, 'aliases.json'),
    pollMs: 60000,
    approvalTtlMs: 3000,
    onError: (e) => errors.push(e.message),
  });
  client.handlers = adapter.handlers;
  client.profile.capabilities = Object.keys(adapter.handlers);
  await adapter.connect();
  projectId = (await api('/projects'))[0].projectId;
});
after(async () => {
  await adapter?.close();
  if (server?.exitCode === null) {
    const exit = once(server, 'exit');
    server.kill();
    await exit;
  }
  if (
    directory &&
    path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) &&
    path.basename(directory).startsWith('xiaomeng-codex-test-')
  )
    await rm(directory, { recursive: true, force: true });
});

test('Codex App Server integration with the real LAN hub and JSON-RPC transport', async (t) => {
  await t.test(
    'imports history without creating phantom streaming and enforces session capabilities',
    async () => {
      const projects = await api('/projects');
      assert.equal(projects[0].provider, 'codex');
      const history = projects[0].sessions.find((s: SessionView) => s.summary === '历史任务');
      assert.equal(history.status, 'done');
      assert.ok(history.updated_at > 1700000000000);
      assert.ok(history.capabilities.includes('message.send'));
      const events = await api(`/sessions/${history.session_id}/events`);
      assert.ok(events.some((e: TaskEvent) => e.detail === '历史输出'));
      const busy = projects[0].sessions.find((s: SessionView) => s.summary === '其他客户端任务');
      assert.deepEqual(busy.capabilities, []);
      await api(`/sessions/${busy.session_id}/control`, { action: 'stop' }, 409);
      await api(`/sessions/${busy.session_id}/message`, { text: 'do not send' }, 409);
    },
  );
  await t.test(
    'starts a task, maps hub session IDs to Codex thread IDs, streams output and diff',
    async () => {
      const sid = await start('hello');
      await until(async () => (await session(sid)).status === 'done');
      const events = await api(`/sessions/${sid}/events`);
      assert.ok(events.some((e: TaskEvent) => e.detail === 'hello'));
      assert.ok(events.some((e: TaskEvent) => e.detail === '任务执行完成'));
      assert.ok(
        events.some((e: TaskEvent) => e.tool_name === 'Diff' && e.detail?.includes('+new')),
      );
      const aliases = JSON.parse(await readFile(path.join(directory, 'aliases.json'), 'utf8'));
      assert.ok(Object.keys(aliases).length);
      const beforeCount = events.length;
      await adapter.sync();
      assert.equal((await api(`/sessions/${sid}/events`)).length, beforeCount);
      assert.equal(
        (await api(`/projects/${projectId}/sessions`)).filter(
          (s: SessionView) => s.session_id === sid,
        ).length,
        1,
      );
    },
  );
  await t.test(
    'reads host models, validates settings, waits for confirmation and exposes host actions',
    async () => {
      const project = (await api('/projects'))[0];
      const history = project.sessions.find((s: SessionView) => s.summary === '历史任务');
      const catalog = await api(
        `/agents/${project.agentId}/catalog?sessionId=${history.session_id}`,
      );
      assert.equal(catalog.models[0].id, 'fixture-model');
      await api(`/agents/${project.agentId}/catalog?sessionId=unknown`, undefined, 404);
      await api(
        `/sessions/${history.session_id}/configure`,
        { settings: { permissions: 'bypass' } },
        400,
      );
      await api(
        `/sessions/${history.session_id}/configure`,
        { settings: { model: 'missing' } },
        502,
      );
      await api(
        `/sessions/${history.session_id}/configure`,
        { settings: { model: 'fixture-model', reasoningEffort: 'invalid' } },
        502,
      );
      const result = await api(`/sessions/${history.session_id}/configure`, {
        settings: { model: 'fixture-model', reasoningEffort: 'high', mode: 'plan' },
        requestId: 'model-settings',
      });
      assert.equal(result.confirmed, true);
      assert.equal(result.appliesTo, 'next_turn');
      assert.equal((await session(history.session_id)).model, 'fixture-model');
      assert.equal((await session(history.session_id)).reasoningEffort, 'high');
      const actions = await api(`/agents/${project.agentId}/actions`, {
        sessionId: history.session_id,
        name: 'skills.list',
        arguments: {},
      });
      assert.equal(actions.entries[0].name, 'fixture-skill');
      assert.deepEqual(
        (
          await api(`/agents/${project.agentId}/actions`, {
            sessionId: history.session_id,
            name: 'plugins.list',
            arguments: {},
          })
        ).entries,
        [],
      );
      await api(
        `/agents/${project.agentId}/actions`,
        { sessionId: history.session_id, name: 'arbitrary.shell', arguments: {} },
        502,
      );
      await api(`/sessions/${history.session_id}/compact`, {});
    },
  );
  await t.test(
    'reads paginated history through the authenticated hub without starting a turn',
    async () => {
      const history = (await api('/projects'))[0].sessions.find(
        (s: SessionView) => s.summary === '历史任务',
      );
      const [first, duplicate] = await Promise.all([
        api(`/sessions/${history.session_id}/history?limit=1`),
        api(`/sessions/${history.session_id}/history?limit=1`),
      ]);
      assert.equal(first.events[0].detail, '历史输出');
      assert.equal(first.events[0].session_id, history.session_id);
      assert.deepEqual(first, duplicate);
      assert.equal(first.nextCursor, null);
      assert.equal((await session(history.session_id)).status, 'done');
      await api(`/sessions/${history.session_id}/history?limit=-1`, undefined, 400);
    },
  );
  await t.test('continues history, steers the exact active turn, and interrupts it', async () => {
    const history = (await api(`/projects/${projectId}/sessions`)).find(
      (s: SessionView) => s.summary === '历史任务',
    );
    const send = await api(`/sessions/${history.session_id}/message`, { text: 'hold' }, 202);
    assert.equal((await receipt(send.commandId)).status, 'succeeded');
    const steer = await api(`/sessions/${history.session_id}/steer`, { text: '追加测试' }, 202);
    assert.equal((await receipt(steer.commandId)).status, 'succeeded');
    await until(async () =>
      (await api(`/sessions/${history.session_id}/events`)).some(
        (e: TaskEvent) => e.detail === '追加测试',
      ),
    );
    const stop = await api(`/sessions/${history.session_id}/control`, { action: 'stop' }, 202);
    assert.equal((await receipt(stop.commandId)).status, 'succeeded');
    await until(async () => (await session(history.session_id)).status === 'paused');
    const late = await api(`/sessions/${history.session_id}/steer`, { text: 'too late' }, 202);
    assert.equal((await receipt(late.commandId)).status, 'failed');
    assert.equal((await session(history.session_id)).status, 'paused');
  });
  for (const kind of ['approval', 'file', 'permissions', 'question']) {
    await t.test(`routes ${kind} and waits for the exact host resolution`, async () => {
      const sid = await start(kind);
      const request = await approval(sid);
      if (kind === 'file') assert.ok(request.diff.includes('+new'));
      if (kind === 'permissions') assert.ok(request.command.includes('network'));
      if (kind === 'question') {
        assert.equal(request.kind, 'input');
        assert.equal(request.questions[0].question, '选择部署环境');
        await api(`/approvals/${request.approvalId}`, { decision: 'approve' }, 400);
      }
      const result = await api(`/approvals/${request.approvalId}`, {
        decision: 'approve',
        ...(kind === 'question' ? { answers: { choice: '测试' } } : {}),
      });
      assert.equal((await receipt(result.commandId)).status, 'succeeded');
      await until(async () => (await session(sid)).status === 'done');
      assert.ok(
        !(await api('/approvals')).some((a: ApprovalView) => a.approvalId === request.approvalId),
      );
      const events = await api(`/sessions/${sid}/events`);
      const expected =
        kind === 'permissions'
          ? '"scope":"turn"'
          : kind === 'question'
            ? '"answers":["测试"]'
            : '"decision":"accept"';
      assert.ok(events.some((e: TaskEvent) => e.detail?.includes(expected)));
    });
  }
  await t.test('expires pending questions and returns a non-approval response', async () => {
    const sid = await start('question');
    const request = await approval(sid);
    await until(
      async () =>
        !(await api('/approvals')).some((a: ApprovalView) => a.approvalId === request.approvalId),
      6000,
    );
    await until(async () =>
      (await api(`/sessions/${sid}/events`)).some((e: TaskEvent) => e.detail === '{"answers":{}}'),
    );
  });
  await t.test('streams terminal output before the command finishes', async () => {
    const sid = await start('terminal');
    const output = await until(async () =>
      (await api(`/sessions/${sid}/events`)).find(
        (e: TaskEvent) =>
          e.hook_event_name === 'ToolOutput' && e.detail?.includes('final buffered chunk'),
      ),
    );
    assert.equal(output.detail, 'test output while running plus final buffered chunk');
    assert.ok(output.tool_call_id.endsWith(':terminal'));
    assert.equal((await session(sid)).status, 'running');
    const stop = await api(`/sessions/${sid}/control`, { action: 'stop' }, 202);
    await receipt(stop.commandId);
  });
  await t.test(
    'missing host confirmation never becomes a successful approval receipt',
    async () => {
      const sid = await start('no-confirm');
      const request = await approval(sid);
      const result = await api(`/approvals/${request.approvalId}`, { decision: 'approve' });
      assert.equal((await receipt(result.commandId)).status, 'failed');
    },
  );
  await t.test('does not expose an unencrypted remote app-server transport', async () => {
    await assert.rejects(new CodexRpc({ url: 'ws://192.168.1.123:9999' }).connect(), /wss/);
  });
  await t.test(
    'shared WebSocket App Server exposes an existing active task for steering and stop',
    async () => {
      const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await once(ws, 'listening');
      const fixture = spawn(
        process.execPath,
        [path.join(root, 'test/fixtures/codex-app-server.js')],
        {
          env: {
            ...process.env,
            FIXTURE_PROJECT: path.join(directory, 'project'),
            FIXTURE_SHARED: '1',
          },
          windowsHide: true,
        },
      );
      const lines = createInterface({ input: fixture.stdout });
      ws.on('connection', (socket) => {
        socket.on('message', (data) => fixture.stdin.write(`${data}\n`));
        /**
         * 把模拟主机输出转发到测试 WebSocket 连接。
         * @param line 一行完整 JSON 协议文本。
         * @returns 无返回值。
         */
        const listener = (line: string) => {
          if (socket.readyState === 1) socket.send(line);
        };
        lines.on('line', listener);
        socket.on('close', () => lines.off('line', listener));
      });
      const rpc = new CodexRpc({ url: `ws://127.0.0.1:${(ws.address() as AddressInfo).port}` });
      const sharedClient = new AgentClient({
        hubUrl: origin,
        enrollmentToken: token,
        agentKey: 'shared-codex',
        name: 'Shared Codex',
        provider: 'codex',
        stateFile: path.join(directory, 'shared-credentials.json'),
        isAvailable: () => rpc.ready,
        onError: (e) => errors.push(e.message),
      });
      const shared = new CodexAgent({
        rpc,
        client: sharedClient,
        projects: [path.join(directory, 'project')],
        stateFile: path.join(directory, 'shared-aliases.json'),
        pollMs: 60000,
      });
      sharedClient.handlers = shared.handlers;
      sharedClient.profile.capabilities = Object.keys(shared.handlers);
      try {
        await shared.connect();
        const project = (await api('/projects')).find(
          (p: ProjectView) => p.agentName === 'Shared Codex',
        );
        const active = project.sessions.find((s: SessionView) => s.summary === '其他客户端任务');
        assert.ok(active.capabilities.includes('message.steer'));
        const steer = await api(
          `/sessions/${active.session_id}/steer`,
          { text: '来自手机的追加' },
          202,
        );
        assert.equal((await receipt(steer.commandId)).status, 'succeeded');
        const stop = await api(`/sessions/${active.session_id}/control`, { action: 'stop' }, 202);
        assert.equal((await receipt(stop.commandId)).status, 'succeeded');
      } finally {
        await shared.close();
        lines.close();
        const exit = once(fixture, 'exit');
        fixture.kill();
        await exit;
        await new Promise((resolve) => ws.close(resolve));
      }
    },
  );
  await t.test('concurrent new tasks keep separate durable session mappings', async () => {
    const sessions = await Promise.all([
      start('first parallel task'),
      start('second parallel task'),
    ]);
    assert.notEqual(sessions[0], sessions[1]);
    const aliases = JSON.parse(await readFile(path.join(directory, 'aliases.json'), 'utf8'));
    for (const sid of sessions) {
      await until(async () => (await session(sid)).status === 'done');
      assert.ok(
        Object.values(aliases).some(
          (rawId) =>
            `lan_session_${createHash('sha256').update(`${client.credentials!.agentId}\0${rawId}`).digest('hex').slice(0, 40)}` ===
            sid,
        ),
      );
      assert.ok(
        (await api(`/sessions/${sid}/events`)).some((e: TaskEvent) =>
          e.detail?.includes('parallel task'),
        ),
      );
    }
  });
});
