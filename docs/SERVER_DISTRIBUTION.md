# 小梦服务端发布包

此包包含已经编译的 JavaScript、配对管理页、依赖锁文件与接入文档，不需要 Flutter 或 TypeScript 编译器。Node.js 使用仓库 `.node-version` 对应的 24.x 版本；CI 在 Windows 与 Linux 验证。

## 安装与启动

1. 下载 GitHub Release 中的 `xiaomeng-server-vX.Y.Z.zip`（Windows）或 `.tar.gz`（Linux），核对 `SHA256SUMS.txt`。
2. 解压到独立版本目录，在含 `package.json` 的目录打开终端。
3. 安装生产依赖：`npm ci --omit=dev`。首次安装需要访问 npm registry。
4. 使用 `npm run host` 同时启动中心服务与本机 Codex。主机需另行安装并登录 Codex CLI。
5. 不接入本机 Codex 时，PowerShell 设置 `$env:LOCAL_CODEX = '0'`，再执行 `npm run host`；Bash 使用 `LOCAL_CODEX=0 npm run host`。

一体启动的配置、数据库和接入身份默认保存在用户目录 `.xiaomeng/host/`，跨版本保留。配对入口以控制台日志中的地址为准。

只运行中心服务时：

```powershell
$env:AUTH_TOKEN = '替换为至少32字符的随机令牌'
$env:LOCAL_CLAUDE = '0'
$env:DB_PATH = 'D:\xiaomeng-data\data.db'
npm start
```

提前创建数据目录。使用固定外部 `DB_PATH`，避免数据库随安装目录被替换。`npm start` 不包含自动注册系统服务；可按自己的运行环境配置进程守护。

## 可用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 运行中心服务 |
| `npm run host` | 一体启动中心服务与本机 Codex |
| `npm run agent:codex` | 接入已有 Codex 主机 |
| `npm run agent:connect` | 连接本机 Claude 桥接服务 |
| `npm run agent:demo` | 启动演示 Agent |
| `npm run sample` | 开发用示例数据发送器 |

命令直接运行 `dist/` 中的 JavaScript。开发源码仓库使用 TypeScript，其开发与构建命令不适用于这个运行包。

## 升级与回退

1. 停止旧服务，备份用户配置、设备/Agent 凭据与数据库。SQLite 采用停机后复制或 SQLite Backup API；不要在运行中只复制主 `.db` 文件而遗漏 WAL 中的数据。
2. 解压新版本到新目录，安装生产依赖，使用原用户和原数据路径启动。
3. 检查 `/health`、配对页、已绑定设备，以及 Agent 在线状态。
4. 如需回退，先停止新服务，再从旧目录启动。若新版本修改了数据库结构且不向后兼容，需同时恢复升级前备份；不要盲目复用新数据库。

更多说明：[扫码绑定](docs/PAIRING.md)、[Codex 接入](docs/CODEX_SETUP.md)、[Agent 协议](docs/AGENT_PROTOCOL.md)。这些文档可能同时包含源码开发示例；运行发布包时优先使用上表中的 npm 命令。
