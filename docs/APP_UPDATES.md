# Android 应用内更新

入口：应用设置 → 版本管理。当前版本直接读取 Android 已安装包的 versionName/versionCode，不依赖硬编码。此功能从 2.0.3（build 18）开始提供；2.0.2 用户需要手动安装一次新版 APK。

2.0.6 起使用新的版本中心：深色版本卡显示当前安装或可更新版本，下方切换“更新说明”和“版本历史”；右上角进入自动更新偏好。说明以 Markdown 预览展示，可选择文字、复制代码和点击链接。即使没有新版本，也会从历史记录中匹配当前安装版本的说明。

历史来自本仓库真实 GitHub Releases，忽略草稿，按发布时间倒序展示，每页 20 条，支持加载更早版本、正式版/测试版筛选和展开详情。筛选仅影响历史阅读，不改变更新渠道，也不提供旧版本降级安装。最近 20 条记录保存在本机，离线或限流时显示已保存内容与重试入口；未发布到 GitHub 的本地版本不会伪造为发布记录。

默认启用自动检查和非计费 Wi-Fi 自动下载。启动、回到前台以及前台每 5 分钟检查调度，每 6 小时最多请求一次版本列表。手动检查不受该间隔限制。下载完成显示应用内提醒，点击安装后进入 Android 系统确认界面；首次使用会先打开“允许来自此来源的应用”设置，授权返回后继续安装。无法绕过系统确认静默安装。

2.0.7 起，同一 URL 的并发请求合并，成功响应在进程内缓存 1 分钟，手动连续检查也会复用这个短缓存。GitHub 匿名 API 配额按公网 IP 共享；收到限流时，遵循 `Retry-After` / `X-RateLimit-Reset` 暂停 API 重试并显示预计恢复时间，不把所有 403 都当作额度耗尽。

可安装更新检查在 API 受限、网络失败或超时时，尝试官方 `github.com` Releases Atom 订阅和同一发布的 `release-manifest.json` 附件。订阅中的 HTML 转换为 Markdown 后展示；安装包仍需有效大小、SHA-256 和版本信息，下载与安装验证不变。正式渠道通过 GitHub `/releases/latest` 的重定向确认正式版本，绝不根据标签名称推测安装渠道。订阅只覆盖 GitHub 提供的近期发布；缺少 manifest 的旧版不能通过这条备用路径安装。历史列表仍使用分页 API，受限时保留本机历史缓存；无缓存时需要等 API 恢复。未发布的本地测试包仍无法通过在线检查发现。

自动下载仅在应用前台开始，下载期间失去非计费 Wi-Fi 会停止；手动下载可使用移动网络。网络失败后自动下载等待 30 分钟再重试，主动取消后等待 6 小时，手动重试不受等待限制。已完成的安装包保存在私有缓存中，可跨进程重启恢复；未完成的下载重新开始。进程关闭期间不轮询版本，也不承诺持续后台下载。

## 发布格式

更新源固定为 `xh20220630/xiaomeng-hub` 的 GitHub Releases 列表，不携带 GitHub token。正式渠道忽略 draft/prerelease；测试渠道允许 prerelease。Android Debug 签名安装默认开启测试渠道，可在页面修改，偏好保存在设备上。

- 正式流水线：`xiaomeng-v{version}-android.apk`，配套 `release-manifest.json` 提供 version、buildNumber、artifacts 中的 name/bytes/sha256。
- 测试发布：`xiaomeng-v{version}-build{buildNumber}-android.apk`，从 GitHub asset 的 `digest: sha256:...` 获取校验值。
- 新版本需要同时满足语义版本不回退、versionCode 严格递增。正式发布沿用仓库统一版本脚本。
- GitHub API 请求超时、限流或网络错误在页面显示，可手动重试。可安装更新检查读取最近 100 个 release，历史阅读采用独立分页。

下载使用 HTTPS，只接受本仓库发布附件及 GitHub 附件 CDN 重定向。安装前重新检查大小、SHA-256、包名、versionName、versionCode、最低 Android 版本及当前签名。FileProvider 仅公开专用更新缓存目录，临时授予系统安装器读取权限。

测试签名与正式签名不能相互覆盖；测试发布必须继续使用原签名密钥。若签名不一致会停止更新并显示原因，不会自动卸载现有应用或清除数据。

验证命令：在 `app/` 执行 `flutter analyze --no-pub`、`flutter test --no-pub` 和 `flutter build apk --release --no-pub`。安装授权、拒绝、取消、覆盖升级及厂商系统差异需真机验证。

备用源联网验证：`flutter test --no-pub test/update_source_test.dart --dart-define=VERIFY_GITHUB_UPDATE_SOURCE=true`。这项检查在本地模拟 API 限流，实际访问公开 GitHub 发布订阅和校验清单；默认测试不联网。
