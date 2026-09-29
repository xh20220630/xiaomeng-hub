# 宿主机文件与图片预览

2026-09-29 · 已实现于 2.0.8 / Android build 23。

## 使用方式

同时更新手机 App 和文件所属的 Host / Codex Agent。打开会话后：

- 点击回答中的 `[文件](src/app.ts:120)` 打开只读预览，显示目标行附近内容；支持搜索已加载内容、选择及复制。
- `.md` 默认展示 Markdown，可切换源码。内部相对图片、文件链接及 `#L行号` 使用当前文件作为上下文。
- 本地图片显示缩略图，点击读取原图，可双指缩放、拖动。支持 Claude 用户消息 / 工具结果与 Codex 实时 / 历史事件中的结构化图片附件。
- 会话右上角 `⋯ → 项目文件` 浏览工作目录，每次只读取当前目录。
- PDF、Office、音视频和其他二进制只显示文件信息；SVG / HTML 展示源文本。暂不支持编辑、下载保存。

本机 Claude 的 JSONL 附件随历史刷新进入手机；Codex 实时事件与分页历史使用相同附件引用。只有占位符、已截断或不存在的旧图片无法恢复，Claude 现有历史读取仍限定记录尾部 4 MiB。

## 来源、身份与目录

手机始终访问已配对 Hub。Hub 按会话对应的 Agent 身份选择读取端，不凭 `nodeId` 或展示路径判断文件属于本机。本机 Claude 直接读取；Codex 所属 Agent 声明 `resources.resolve/read/list`，通过原生文件 API 读取，与执行权限独立。旧 Agent、未实现资源能力的自定义或 Claude relay Agent 显示不支持提示。

默认只读当前会话工作目录。额外目录需要在文件所属 Host / Agent 启动前配置 `RESOURCE_ROOTS`，Windows 用分号分隔，其他平台用冒号。例如 PowerShell：

```powershell
$env:RESOURCE_ROOTS = 'D:\SharedAssets;D:\DesignExports'
npm run host --prefix server
```

支持中文、空格、Windows 盘符、POSIX 路径、`file:` URI、一次 URL 解码、`:行:列` / `#L行`。拒绝 UNC / 设备路径和越界实际路径，检查符号链接 / junction 最终目标与文件句柄身份。文件变更、替换或删除时要求刷新。项目外图片需显式共享目录，或通过来源提供的 base64 附件读取，不能仅凭回答中的绝对路径获得权限。

所有资源接口强制非空 `AUTH_TOKEN` 和有效 Bearer 请求头，不接受 URL 查询参数令牌。资源 ID 绑定设备身份、会话和来源 Agent，并有期限和数量上限。外站图片 / 链接不携带主机令牌。

远端 Agent 通过短期上传槽提交二进制。文件内容不进入命令回执、SQLite 事件或全局 WebSocket 广播。请求取消、配对撤销或超时后不再交付文件；已经开始的源端读取 / 转换可能运行至结束，但上传槽已失效。已有内容不能通过服务器撤销远程抹除。

## HTTP 接口

| 接口 | 用途 |
| --- | --- |
| `POST /api/sessions/:id/resources/resolve` | JSON：`reference`、可选 `baseResourceId`；返回资源元数据 |
| `GET /api/resources/:id` | 授权记录的元数据；磁盘版本在内容读取时再次检查 |
| `GET /api/resources/:id/text?version=…&startLine=1` | 文本分段、编码、截断标记、`nextLine` |
| `GET /api/resources/:id/thumbnail?version=…` | 受限 WebP 缩略图 |
| `GET /api/resources/:id/content?version=…` | 受限原始静态图片字节 |
| `GET /api/resources/:id/entries?cursor=…` | 目录条目与下一页游标 |
| `POST /agent/resources/transfers/:id` | 仅绑定的 Agent 可提交二进制 |

元数据包含 `resourceId/name/kind/mimeType/size/version/modifiedAt/snapshot/previewAvailable/line/sourceName`。版本为文件身份与修改信息摘要；首期没有 HTTP Range / ETag 协议。成功响应设置 `private, no-store` 和 `nosniff`。错误返回 JSON，例如 `HOST_OFFLINE`、`UNSUPPORTED_HOST`、`NOT_FOUND`、`OUTSIDE_ROOT`、`RESOURCE_CHANGED`、`TOO_LARGE`。

## 大小与缓存限制

- 文本每页最多 200 行 / 256 KiB，仅读取文件前 4 MiB；手机单页累计最多 2000 行，搜索只覆盖已加载内容。支持 UTF-8 与带 BOM 的 UTF-16；大文件和超长行明确提示截断。
- 静态 PNG / JPEG / WebP：最大 20 MiB、2500 万像素；缩略图最长边 1024 px，转换并发 2、限时 10 秒。动画图片不支持。
- 目录每页 100 项，单目录最多 10000 项；列表跳过符号链接，不递归扫描项目。
- Hub 最多 16 个活动请求、4 个远端上传槽；远端命令 25 秒、槽位 26 秒超时。采用有大小上限的内存缓冲，没有无限流式下载。
- 手机图片字节缓存最多 32 MiB，切换连接或认证失败清理；关闭页面取消请求。已解码图片仍由 Flutter ImageCache 管理。
- 附件按内容哈希存入 `~/.xiaomeng/resources` 的私有会话目录，可用 `RESOURCE_CACHE_DIR` 覆盖。写入时清理：每会话 128 MiB、总量 512 MiB，淘汰超过 30 天的旧快照。源记录仍有图片时，再次读取历史可恢复已清理附件。
- 当前 App 沿用 HTTP，定位于受信任局域网；跨公网 HTTPS 地址配置另行实施。

## 验证与边界

自动测试覆盖 Windows 路径、行号、junction 越界、文件变更 / 删除、编码与截断、图片解码及像素限制、快照隔离 / 配额、多 Agent 同显示路径、设备令牌隔离、读取中撤销权限、二进制不进入广播 / 回执、Claude / Codex 附件一致性、Markdown 相对路径及手机窄屏交互。

尚未连接真实 Android 设备或第二台物理宿主机，双指缩放体验及大图片真机内存表现仍需设备验收；多 Agent 测试使用同机独立 Agent 和临时目录。
