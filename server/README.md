# 小梦中心服务与 Agent 接入端

Node.js ≥22.5，Express + WebSocket + SQLite。默认监听 `0.0.0.0:4820`。

完整启动和多机器接入步骤见 [项目 README](../README.md)，接口及回执语义见 [Agent 接入协议](../docs/AGENT_PROTOCOL.md)。

| 命令 | 用途 |
|---|---|
| `npm start` | 启动中心服务，同时启用本机 Claude 适配器 |
| `npm run host` | 一起启动中心服务和本机 Codex；持久保存绑定与接入身份，自动恢复 Codex 接入 |
| `npm run dev` | 开发模式，代码变化后重启 |
| `npm run agent:demo` | 连接中心服务的通用演示 Agent |
| `npm run agent:connect` | 把本机 Claude 桥接服务接入另一台中心服务 |
| `npm test` | 临时数据库与独立端口上的集成测试 |

远程接入必须设置中心服务的 `AUTH_TOKEN`。纯中心服务可以设置 `LOCAL_CLAUDE=0`。

启动后，在宿主机打开 `http://localhost:4820/pair/`，使用小梦 APP 的“扫码绑定宿主机”连接。页面提供二维码、网卡选择和设备解绑；管理页面仅限本机访问。见 [扫码绑定说明](../docs/PAIRING.md)。

原有 `sample/seed-demo/gate-e2e` 等脚本属于早期 Claude hooks 开发工具；通用平台演示请使用 `agent:demo`。

生产数据默认保存在 `data.db`；测试显式使用临时 `DB_PATH`，不会清空现有会话或审批数据。
