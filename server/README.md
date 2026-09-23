# 小梦中心服务与 Agent 接入端

TypeScript 严格模式，Node.js ≥22.5，Express + WebSocket + SQLite。默认监听 `0.0.0.0:4820`。

完整启动和多机器接入步骤见 [项目 README](../README.md)，接口及回执语义见 [Agent 接入协议](../docs/AGENT_PROTOCOL.md)。

| 命令 | 用途 |
|---|---|
| `npm ci` | 按锁文件安装依赖与 TypeScript 工具链 |
| `npm start` | 编译后启动中心服务，同时启用本机 Claude 适配器 |
| `npm run host` | 编译后一起启动中心服务和本机 Codex；持久保存绑定与接入身份，自动恢复 Codex 接入 |
| `npm run dev` | 使用 tsx 运行源码，代码变化后重启 |
| `npm run build` | 编译应用与运维脚本到 `dist/`，生成声明文件和 source map |
| `npm run typecheck` | 检查应用、脚本与测试的严格类型，不生成文件 |
| `npm run format` / `npm run format:check` | 格式化 / 检查 TypeScript 与项目配置格式 |
| `npm run agent:demo` | 连接中心服务的通用演示 Agent |
| `npm run agent:codex` | 运行 Codex 接入端源码 |
| `npm run agent:connect` | 把本机 Claude 桥接服务接入另一台中心服务 |
| `npm test` | 编译后运行临时数据库与独立端口上的集成测试 |

远程接入必须设置中心服务的 `AUTH_TOKEN`。纯中心服务可以设置 `LOCAL_CLAUDE=0`。

启动后，在宿主机打开 `http://localhost:4820/pair/`，使用小梦 APP 的“扫码绑定宿主机”连接。页面提供二维码、网卡选择和设备解绑；管理页面仅限本机访问。见 [扫码绑定说明](../docs/PAIRING.md)。

原有 `sample/seed-demo/gate-e2e` 等脚本属于早期 Claude hooks 开发工具；通用平台演示请使用 `agent:demo`。

生产数据默认保存在 `data.db`；测试显式使用临时 `DB_PATH`，不会清空现有会话或审批数据。

## 目录与职责

```text
server/
├── src/
│   ├── index.ts          进程入口：监听端口、后台任务与退出
│   ├── app.ts            HTTP 应用装配与认证边界
│   ├── config/           环境配置与服务器根路径
│   ├── routes/           路径、方法和控制器绑定
│   ├── controllers/      HTTP / WebSocket 参数与响应适配
│   ├── middleware/       身份认证、来源约束与错误处理
│   ├── services/         业务校验、流程协调与操作分发
│   ├── repositories/     SQL、存储行映射及进程内状态存取
│   ├── infrastructure/   SQLite 连接与基础表结构
│   ├── domain/           状态推导、活动规则和差异计算
│   ├── adapters/
│   │   ├── claude/       CLI、会话记录与文件监听
│   │   └── codex/        App Server、桌面 IPC 与主机索引
│   ├── events/           应用广播及 Agent 命令唤醒
│   ├── transport/        WebSocket 连接与消息投递
│   ├── sdk/              通用 Agent 客户端
│   ├── types/            业务契约、协议 DTO、存储行与配置类型
│   └── utils/            通用错误归一等基础工具
├── scripts/              TypeScript 启动、接入与联调脚本
├── test/                 TypeScript 协议与集成测试
├── public/pair/          浏览器直接加载的扫码管理页静态资源
├── tsconfig.json         应用、脚本与测试共用的严格配置
├── tsconfig.build.json   生产构建配置，不包含测试
└── dist/                 编译产物，由命令生成，不提交
```

接口调用沿 `routes → controllers → services → repositories / adapters` 组织。路由只绑定路径；控制器读取请求、写入响应；服务决定资源归属、能力、幂等和状态变化；仓储拥有 SQL，适配器负责外部主机协议。业务服务通过 `events/` 发布消息，由传输层投递，服务无需持有 WebSocket 连接。

`types/` 区分请求负载、客户端视图和数据库行，避免把存储结构直接当作接口契约。`domain/` 放不依赖 HTTP 的状态与格式规则。配对模块使用工厂注入数据库、时钟和网卡枚举函数，测试可以独立验证过期、重放和身份隔离。

## 开发约定

- 新接口先定义输入与输出类型，再添加仓储或适配器能力、服务规则、控制器和路由。HTTP 请求仍需运行时校验，TypeScript 类型不能替代外部输入校验。
- 函数使用中文 JSDoc 说明目的和必要约束，填写 `@param`、`@returns`；接口和属性说明业务含义、单位及可选语义。行内注释解释兼容性、边界或设计原因。
- 异步控制器通过 `asyncHandler` 转交错误；统一错误响应在 `middleware/http.ts`，不要在路由中复制异常处理。
- 项目使用 NodeNext ESM；源码中的相对导入保留 `.js` 扩展名，TypeScript 会解析到对应 `.ts`，编译后由 Node 直接加载。
- TypeScript 源码、SDK 和测试统一位于以上目录。`public/pair/app.js` 是浏览器静态脚本，独立于 Node 后端编译；服务端原 `.js` / `.mjs` 实现已迁入 `.ts`。

通用接入示例见 [demo-agent.ts](scripts/demo-agent.ts)，SDK 位于 [agent-client.ts](src/sdk/agent-client.ts)。源码运行使用 `tsx`（例如 `npx tsx scripts/send-sample.ts`）；已编译入口使用 `node dist/src/index.js` 或 `node dist/scripts/start-host.js`。不要直接用 Node 运行已删除的旧 `.mjs` 入口。

`config/paths.ts` 从源码或编译目录向上定位 `server/package.json`。因此默认数据库始终位于 `server/data.db`，扫码页始终读取 `server/public/pair`，不会因为编译到 `dist/` 而更换数据位置。分发包需要同时保留 `package.json`、`dist/` 与 `public/`；发布包安装步骤见 [服务端分发说明](../docs/SERVER_DISTRIBUTION.md)。

## 验证

```powershell
npm run typecheck
npm run format:check
npm test
npm run build
```

测试使用模拟 Agent、App Server、桌面 IPC、临时数据库和随机端口，覆盖身份隔离、命令回执、审批、配对撤销以及宿主机重启后的身份复用，不调用真实模型。生产构建排除测试源码；若之前运行过测试，`dist/test/` 中可能留有测试产物，发布时仅选取应用和启动脚本目录。
