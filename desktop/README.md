# 小梦 Host 桌面应用

基于 Tauri 2 的 Windows 宿主机启动器。打开应用后检查 `http://localhost:4897/pair/info`；已有可用的小梦服务则直接复用，否则启动内置后端的 `start-host.js`，就绪后在原生 WebView 中打开 **http://localhost:4897/pair/**。

- 复用现有扫码页，支持二维码、网卡选择、Agent 状态和设备解绑。
- 启动失败或服务中断时回到启动页，显示日志并支持重试。
- 退出时通过管道通知自己启动的 host 关闭中心和 Codex 接入端；复用的外部服务继续运行。
- 单实例运行，再次打开会聚焦已有窗口。启动后端不弹出命令行窗口。
- 安装包携带当前构建平台的 Node.js、编译后端和生产依赖，使用者无需另装 Node.js。

## 开发

需要 Node.js ≥22.5、Rust stable，以及 [Tauri Windows 环境依赖](https://v2.tauri.app/start/prerequisites/#windows)（MSVC C++ Build Tools、Windows SDK、WebView2）。

从仓库根目录执行：

```powershell
npm ci --prefix server
cd desktop
npm ci
npm run dev
```

开发和打包命令都会先编译后端、准备生产依赖及 Node.js 资源。资源位于被 Git 忽略的 `src-tauri/resources/`，不会包含开发数据库、令牌或用户配置。首次构建需要下载 Rust 依赖。

## Windows 安装包

在 Windows 上运行：

```powershell
cd desktop
npm run build
```

NSIS 安装包输出到 `src-tauri/target/release/bundle/nsis/`，按当前用户安装，缺少 WebView2 时安装器会引导安装。安装包版本读取仓库根目录 `version.json`。请分发安装包；单独复制主程序 exe 不包含后端资源。当前交付目标是 Windows，其他平台需要配置对应 bundle target 并单独验证。

## 服务与配置

桌面入口固定使用 **4897**，启动子进程时覆盖 `PORT`；原命令行 host 默认端口保持不变。仍使用 `~/.xiaomeng/host/config.json`、数据库与 Codex 身份，保留已有设备绑定。可使用 `XIAOMENG_HOST_CONFIG` 指向另一份持久配置。

使用 Codex 接入时仍需安装并登录 Codex CLI。`LOCAL_CODEX=0` 可仅启动中心；其余 `LOCAL_CLAUDE`、`CODEX_*` 等配置沿用 [服务端说明](../server/README.md)。中心默认监听局域网，手机需要能访问电脑的 4897 端口。

如果 4897 已被不兼容或未启用认证的服务占用，应用会显示错误，不会终止现有服务或改用其他端口。退出应用会断开由本应用启动的中心服务连接；如需长期独立运行，可先使用命令行启动 host，再打开应用复用它。

页面使用顶层 WebView 加载，兼容后端的 `frame-ancestors 'none'` 和同源校验。只有打包的启动页可以调用查看状态、重试两个本机命令；HTTP 配对页没有 Tauri 命令权限，主窗口导航限制在启动页与固定连接入口。权限实现参照 [Tauri capabilities](https://v2.tauri.app/security/capabilities/)。

## 定向验证

```powershell
npm run build --prefix ../server
npm run test:host
cargo test --manifest-path src-tauri/Cargo.toml
```

Node 测试使用临时配置、随机端口并禁用真实 Agent，验证正常退出、父进程断开、启动中退出、端口冲突及身份复用。Rust 测试验证导航范围与后端响应识别；Rust 编译前需运行过 `npm run prepare:host`。
