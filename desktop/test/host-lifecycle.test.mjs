import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runtime = process.env.XIAOMENG_TEST_RUNTIME && path.resolve(process.env.XIAOMENG_TEST_RUNTIME);
const server = runtime ? path.join(runtime, 'server') : fileURLToPath(new URL('../../server', import.meta.url));
const node = runtime ? path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath;

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-desktop-test-'));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        child.stdin.end();
        await waitForExit(child);
      }
    }
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('xiaomeng-desktop-test-')) {
      await rm(resolved, { recursive: true, force: true });
    }
  });
  const start = (port, configName = 'config.json') => {
    const child = spawn(node, ['--disable-warning=ExperimentalWarning', 'dist/scripts/start-host.js'], {
      cwd: server,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        XIAOMENG_HOST_CONFIG: path.join(directory, configName),
        XIAOMENG_DESKTOP_CONTROL: '1',
        HOST: '127.0.0.1', PORT: String(port), AUTH_TOKEN: '', AGENT_TOKEN: '', DB_PATH: '',
        LOCAL_CLAUDE: '0', LOCAL_CODEX: '0',
      },
    });
    children.push(child);
    child.logs = '';
    child.stdout.on('data', (chunk) => { child.logs += chunk; });
    child.stderr.on('data', (chunk) => { child.logs += chunk; });
    return child;
  };
  return { directory, start };
}

async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  const result = await Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Host did not exit: ${child.logs}`)), 9000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }),
  ]);
  return result[0];
}

async function ready(child, port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, child.logs);
    if (child.logs.includes(`[host] 连接入口 http://localhost:${port}/pair/`)) {
      const response = await fetch(`http://127.0.0.1:${port}/pair/info`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).authEnabled, true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(child.logs);
}

for (const mode of ['shutdown command', 'parent pipe closes']) {
  test(`desktop host releases its port when ${mode}`, { timeout: 20000 }, async (t) => {
    const { start } = await fixture(t);
    const port = await freePort();
    const child = start(port);
    await ready(child, port);
    if (mode === 'shutdown command') child.stdin.write('shutdown\n');
    else child.stdin.end();
    assert.equal(await waitForExit(child), 0, child.logs);
    const listener = net.createServer();
    listener.listen(port, '127.0.0.1');
    await once(listener, 'listening');
    await new Promise((resolve) => listener.close(resolve));
  });
}

test('desktop restart preserves durable host identity', { timeout: 30000 }, async (t) => {
  const { directory, start } = await fixture(t);
  const port = await freePort();
  const first = start(port);
  await ready(first, port);
  const config = await readFile(path.join(directory, 'config.json'), 'utf8');
  first.stdin.end();
  await waitForExit(first);
  const second = start(port);
  await ready(second, port);
  assert.equal(await readFile(path.join(directory, 'config.json'), 'utf8'), config);
  assert.equal(second.logs.includes(JSON.parse(config).authToken), false);
});

test('an occupied port fails without terminating the existing service', { timeout: 20000 }, async (t) => {
  const { start } = await fixture(t);
  const port = await freePort();
  const first = start(port);
  await ready(first, port);
  const second = start(port, 'other-config.json');
  assert.notEqual(await waitForExit(second), 0);
  assert.match(second.logs, /EADDRINUSE|端口/);
  assert.equal(first.exitCode, null);
  assert.equal((await fetch(`http://127.0.0.1:${port}/pair/info`)).status, 200);
});

test('closing the parent pipe during startup leaves no host process', { timeout: 20000 }, async (t) => {
  const { start } = await fixture(t);
  const port = await freePort();
  const child = start(port);
  child.stdin.end();
  await waitForExit(child);
  const listener = net.createServer();
  listener.listen(port, '127.0.0.1');
  await once(listener, 'listening');
  await new Promise((resolve) => listener.close(resolve));
});
