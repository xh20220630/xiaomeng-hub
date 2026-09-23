import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const configFile = path.resolve(process.env.XIAOMENG_HOST_CONFIG || path.join(os.homedir(), '.xiaomeng', 'host', 'config.json'));
const stateDirectory = path.dirname(configFile);
await mkdir(stateDirectory, { recursive: true });
let config;
try { config = JSON.parse(await readFile(configFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = { port: Number(process.env.PORT || 4820), authToken: process.env.AUTH_TOKEN || randomBytes(32).toString('hex'),
    dbPath: path.join(stateDirectory, 'data.db'), nodeId: os.hostname() };
  await writeFile(configFile, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
}
const port = Number(process.env.PORT || config.port);
const authToken = process.env.AUTH_TOKEN || config.authToken;
if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof authToken !== 'string' || authToken.length < 16) {
  throw new Error('主机配置无效：需要有效端口及至少 16 字符的 AUTH_TOKEN');
}
const env = { ...process.env, PORT: String(port), HOST: process.env.HOST || '0.0.0.0', AUTH_TOKEN: authToken,
  DB_PATH: process.env.DB_PATH || config.dbPath, LOCAL_CLAUDE: process.env.LOCAL_CLAUDE || '0' };
const children = new Set();
let stopping = false;
let retryTimer;
let retryDelay = 3000;

function launch(script, childEnv) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
    cwd: root, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once('exit', () => children.delete(child));
  child.once('error', (error) => console.error('[host]', error.message));
  return child;
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(retryTimer);
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill();
  })));
  process.exitCode = code;
  if (process.connected) process.disconnect();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('message', (message) => { if (message?.type === 'shutdown') void stop(); });

const hub = launch('src/index.js', env);
hub.once('exit', (code) => { if (!stopping) void stop(code || 1); });
await new Promise((resolve, reject) => {
  let output = '';
  const exited = () => reject(new Error('中心服务启动失败；请检查端口是否被占用'));
  hub.once('exit', exited);
  hub.once('error', reject);
  hub.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-4096);
    if (output.includes('listening on')) { hub.off('exit', exited); resolve(); }
  });
});

function startCodex() {
  if (stopping) return;
  const agent = launch('scripts/codex-agent.mjs', { ...env,
    HUB_URL: `http://127.0.0.1:${port}`, HUB_TOKEN: env.AGENT_TOKEN || authToken,
    NODE_ID: config.nodeId, NODE_NAME: os.hostname(), AGENT_KEY: 'codex', AGENT_NAME: 'Codex',
    CODEX_SCOPE: process.env.CODEX_SCOPE || 'host',
    CODEX_PROJECTS: process.env.CODEX_PROJECTS || JSON.stringify([path.resolve(root, '..')]),
    AGENT_STATE_FILE: path.join(stateDirectory, 'codex-agent.json'),
    CODEX_AGENT_STATE_FILE: path.join(stateDirectory, 'codex-threads.json'),
  });
  agent.stdout.on('data', (chunk) => { if (String(chunk).includes('[codex-agent] ready:')) retryDelay = 3000; });
  agent.once('exit', () => {
    if (stopping) return;
    console.error(`[host] Codex 接入中断，将在 ${retryDelay / 1000} 秒后重试；APP 在线状态以实际心跳为准`);
    retryTimer = setTimeout(startCodex, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  });
}
if (process.env.LOCAL_CODEX !== '0') startCodex();
console.log(`[host] 配置已保存在 ${configFile}`);
console.log(`[host] 连接入口 http://localhost:${port}/pair/`);
