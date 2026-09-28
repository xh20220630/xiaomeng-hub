import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = path.resolve(desktop, '..');
const resources = path.join(desktop, 'src-tauri', 'resources');
const server = path.join(root, 'server');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) throw new Error('需要 Node.js >= 22.5（内置 SQLite）');
const platform = { win32: 'windows', darwin: 'macos' }[process.platform] || process.platform;
if (process.env.TAURI_ENV_PLATFORM && process.env.TAURI_ENV_PLATFORM !== platform) {
  throw new Error('请在目标操作系统上构建，安装包需要同平台的 Node.js');
}
const targetArch = process.env.TAURI_ENV_ARCH;
if (targetArch && targetArch !== ({ x64: 'x86_64', arm64: 'aarch64', ia32: 'x86' }[process.arch] || process.arch)) {
  throw new Error('请使用与目标架构一致的 Node.js 构建');
}

function run(file, args, cwd = root) {
  const result = spawnSync(file, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(file)} 退出码 ${result.status}`);
}

const tsc = path.join(server, 'node_modules', 'typescript', 'bin', 'tsc');
if (!(await stat(tsc).catch(() => null))?.isFile()) {
  throw new Error('缺少后端开发依赖，请先在仓库根目录运行 npm ci --prefix server');
}
const npmCli = process.env.npm_execpath;
if (!npmCli || !npmCli.endsWith('.js')) throw new Error('请通过 npm run prepare:host 运行此脚本');
run(process.execPath, [tsc, '-p', path.join(server, 'tsconfig.build.json')]);

const temporary = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-desktop-'));
try {
  run(process.execPath, [path.join(root, 'scripts/release/stage-server.mjs'), path.join(temporary, 'server')]);
  run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(temporary, 'server'));
  await cp(process.execPath, path.join(temporary, process.platform === 'win32' ? 'node.exe' : 'node'));
  const licensePath = path.join(path.dirname(process.execPath), 'LICENSE');
  let license;
  if ((await stat(licensePath).catch(() => null))?.isFile()) {
    license = await readFile(licensePath, 'utf8');
  } else {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`无法读取 Node.js LICENSE：${response.status}`);
    license = await response.text();
  }
  await writeFile(path.join(temporary, 'NODE-LICENSE.txt'), license);
  await writeFile(path.join(temporary, 'runtime.json'), `${JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch }, null, 2)}\n`);
  // 仅替换固定的生成目录，不把宿主机配置、数据库或开发依赖带入安装包。
  if (path.dirname(resources) !== path.join(desktop, 'src-tauri')) throw new Error('无效的资源路径');
  await rm(resources, { recursive: true, force: true });
  await mkdir(resources, { recursive: true });
  await cp(temporary, resources, { recursive: true });
  console.log(`桌面运行资源已生成：${resources}`);
} finally {
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('xiaomeng-desktop-')) {
    await rm(resolved, { recursive: true, force: true });
  }
}
