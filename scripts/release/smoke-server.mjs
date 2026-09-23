import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const directory = process.argv[2] && path.resolve(process.argv[2]);
if (!directory) throw new Error('Usage: smoke-server.mjs <installed-server-package>');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-release-smoke-'));
const authToken = randomBytes(32).toString('hex');
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/src/index.js'], {
  cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AUTH_TOKEN: authToken, LOCAL_CLAUDE: '0',
    DB_PATH: path.join(temporary, 'smoke.db') },
});
let logs = '', spawnError;
child.stdout.on('data', (data) => { logs += data; });
child.stderr.on('data', (data) => { logs += data; });
child.on('error', (error) => { spawnError = error; });
try {
  const deadline = Date.now() + 15000;
  while (!/listening on 127\.0\.0\.1:(\d+)/.test(logs)) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Package did not start:\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const origin = `http://127.0.0.1:${logs.match(/listening on 127\.0\.0\.1:(\d+)/)[1]}`;
  const get = (endpoint) => fetch(origin + endpoint, { signal: AbortSignal.timeout(5000) });
  assert.equal((await (await get('/health')).json()).ok, true);
  const pairing = await get('/pair/');
  assert.equal(pairing.status, 200, 'Pairing static files must be present in the release');
  assert.match(await pairing.text(), /<html/i);
  assert.equal((await get('/api/sessions')).status, 401);
  console.log('Packaged server: startup, SQLite, health, pairing page and auth passed');
} finally {
  if (child.exitCode === null && !spawnError) {
    const exited = once(child, 'exit');
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill();
    const timer = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temporary, { recursive: true, force: true });
}
