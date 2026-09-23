import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('host launcher starts the hub and Codex together and reuses durable credentials after restart', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-host-start-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const configFile = path.join(directory, 'config.json');
  let child;
  let logs = '';
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.send({ type: 'shutdown' });
    const timer = setTimeout(() => child.kill(), 7000);
    await exited;
    clearTimeout(timer);
  }
  t.after(async () => {
    await stop();
    const resolved = path.resolve(directory);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('xiaomeng-host-start-')) {
      await rm(resolved, { recursive: true, force: true });
    }
  });
  async function start() {
    logs = '';
    child = spawn(process.execPath, ['scripts/start-host.mjs'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, XIAOMENG_HOST_CONFIG: configFile, PORT: String(port), HOST: '127.0.0.1',
        AUTH_TOKEN: '', DB_PATH: '', LOCAL_CLAUDE: '0', LOCAL_CODEX: '1', CODEX_SCOPE: 'projects', CODEX_DESKTOP: '0',
        CODEX_APP_SERVER_URL: '', CODEX_BIN: path.join(root, 'test', 'fixtures', 'codex-app-server.mjs'),
        CODEX_PROJECTS: JSON.stringify([directory]), FIXTURE_PROJECT: directory },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Host did not become ready: ' + logs)), 10000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Host exited: ' + logs)); });
      child.stderr.on('data', (chunk) => { logs += chunk; });
      child.stdout.on('data', (chunk) => {
        logs += chunk;
        if (logs.includes('[codex-agent] ready:')) { clearTimeout(timer); resolve(); }
      });
    });
  }
  await start();
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const origin = `http://127.0.0.1:${port}`;
  const before = await (await fetch(origin + '/pair/info')).json();
  assert.equal(before.agents.filter((agent) => agent.provider === 'codex' && agent.online).length, 1);
  assert.equal(logs.includes(config.authToken), false);
  const credentials = JSON.parse(await readFile(path.join(directory, 'codex-agent.json'), 'utf8'));
  await stop();
  await start();
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), config);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'codex-agent.json'), 'utf8')), credentials);
  const after = await (await fetch(origin + '/pair/info')).json();
  assert.equal(after.agents.length, 1);
  assert.equal(after.agents[0].online, true);
  assert.equal(after.agents[0].agentId, before.agents[0].agentId);
});
