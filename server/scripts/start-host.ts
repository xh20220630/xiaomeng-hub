/** 开发与运维入口：管理中心和本机 Codex 子进程的启动与退出。 */
import type { ChildProcess } from 'node:child_process';
import { SERVER_ROOT } from '../src/config/paths.js';
import { asError } from '../src/utils/errors.js';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 一体启动的持久配置；重启必须复用令牌以保留设备绑定。 */
interface HostConfig {
  /** 中心监听端口。 */
  port: number;
  /** 管理员令牌。 */
  authToken: string;
  /** 持久数据库路径。 */
  dbPath: string;
  /** 稳定主机 ID。 */
  nodeId: string;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const configFile = path.resolve(
  process.env.XIAOMENG_HOST_CONFIG || path.join(os.homedir(), '.xiaomeng', 'host', 'config.json'),
);
const stateDirectory = path.dirname(configFile);
await mkdir(stateDirectory, { recursive: true });
let config: HostConfig;
try {
  config = JSON.parse(await readFile(configFile, 'utf8'));
} catch (cause) {
  const error = asError(cause);
  if (error.code !== 'ENOENT') throw error;
  config = {
    port: Number(process.env.PORT || 4820),
    authToken: process.env.AUTH_TOKEN || randomBytes(32).toString('hex'),
    dbPath: path.join(stateDirectory, 'data.db'),
    nodeId: os.hostname(),
  };
  await writeFile(configFile, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
}
const port = Number(process.env.PORT || config.port);
const authToken = process.env.AUTH_TOKEN || config.authToken;
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  typeof authToken !== 'string' ||
  authToken.length < 16
) {
  throw new Error('主机配置无效：需要有效端口及至少 16 字符的 AUTH_TOKEN');
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(port),
  HOST: process.env.HOST || '0.0.0.0',
  AUTH_TOKEN: authToken,
  DB_PATH: process.env.DB_PATH || config.dbPath,
  LOCAL_CLAUDE: process.env.LOCAL_CLAUDE || '0',
};
const children = new Set<ChildProcess>();
let stopping = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 3000;

/**
 * 启动受宿主机管理的子进程，保留日志与退出通知。
 * @param script 由当前宿主机启动的入口文件。
 * @param childEnv 子进程专用环境变量。
 * @returns 已创建的子进程句柄。
 */
function launch(script: string, childEnv: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
    cwd: root,
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout!.pipe(process.stdout);
  child.stderr!.pipe(process.stderr);
  child.once('exit', () => children.delete(child));
  child.once('error', (error) => console.error('[host]', error.message));
  return child;
}

/**
 * 终止中心与 Agent 子进程，防止宿主机退出后留下后台服务。
 * @param code 进程最终退出码。
 * @returns 操作完成的异步信号。
 */
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(retryTimer);
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          const timer = setTimeout(() => child.kill(), 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          if (child.connected) child.send({ type: 'shutdown' });
          else child.kill();
        }),
    ),
  );
  process.exitCode = code;
  if (process.connected) process.disconnect();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('message', (message) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown')
    void stop();
});

const hub = launch('src/index.js', env);
hub.once('exit', (code) => {
  if (!stopping) void stop(code || 1);
});
await new Promise<void>((resolve, reject) => {
  let output = '';
  /**
   * 在中心未就绪时提前退出等待，保留可诊断的启动失败。
   * @returns 无返回值。
   */
  const exited = () => reject(new Error('中心服务启动失败；请检查端口是否被占用'));
  hub.once('exit', exited);
  hub.once('error', reject);
  hub.stdout!.on('data', (chunk) => {
    output = (output + chunk).slice(-4096);
    if (output.includes('listening on')) {
      hub.off('exit', exited);
      resolve();
    }
  });
});

/**
 * 启动接入端并在意外退出后退避重试，复用已保存身份。
 * @returns 无返回值。
 */
function startCodex() {
  if (stopping) return;
  const agent = launch('scripts/codex-agent.js', {
    ...env,
    HUB_URL: `http://127.0.0.1:${port}`,
    HUB_TOKEN: env.AGENT_TOKEN || authToken,
    NODE_ID: config.nodeId,
    NODE_NAME: os.hostname(),
    AGENT_KEY: 'codex',
    AGENT_NAME: 'Codex',
    CODEX_SCOPE: process.env.CODEX_SCOPE || 'host',
    CODEX_PROJECTS: process.env.CODEX_PROJECTS || JSON.stringify([path.resolve(SERVER_ROOT, '..')]),
    AGENT_STATE_FILE: path.join(stateDirectory, 'codex-agent.json'),
    CODEX_AGENT_STATE_FILE: path.join(stateDirectory, 'codex-threads.json'),
  });
  agent.stdout!.on('data', (chunk) => {
    if (String(chunk).includes('[codex-agent] ready:')) retryDelay = 3000;
  });
  agent.once('exit', () => {
    if (stopping) return;
    console.error(
      `[host] Codex 接入中断，将在 ${retryDelay / 1000} 秒后重试；APP 在线状态以实际心跳为准`,
    );
    retryTimer = setTimeout(startCodex, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  });
}
if (process.env.LOCAL_CODEX !== '0') startCodex();
console.log(`[host] 配置已保存在 ${configFile}`);
console.log(`[host] 连接入口 http://localhost:${port}/pair/`);
