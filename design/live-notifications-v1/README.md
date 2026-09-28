# 小梦 · 实时通知主题

2026-09-28，Android 2.0.4（build 19）。先使用内置 `image_gen.imagegen` 生成设计图和角色素材，再实现原生通知与 Flutter 外观预览。完整提示词保存在 [prompts.json](prompts.json)。

## 设计与素材

- [设计图](design-board.png)：瓷白小梦、深墨卡片、青柠进度、琥珀色待确认状态。
- [运行](sources/running.png)、[待确认](sources/approval.png)、[完成](sources/completed.png)、[离线](sources/offline.png)：四张独立生成的原图。它们是刻意保留深墨底的 RGB 角色徽章，界面按圆形裁剪，未宣称具有透明底。
- [导出清单](asset-manifest.json)：256 × 256 PNG，Flutter 与 Android 使用同一份输出。生成阶段的透明底尝试返回了不透明网格，因此未纳入项目；透明进度图标复用现有 `ui-v3/mascot-avatar.png`。
- `scripts/design/package-live-notifications.cjs` 可重新导出尺寸与清单，依赖 Sharp；不需要重新生成图像。

运行素材位于 `app/assets/live-notifications/` 和 `app/android/app/src/main/res/drawable-nodpi/meng_live_*.png`。系统状态栏使用新的白色长耳小梦矢量图标 `ic_stat_meng_live.xml`，文字、进度条、卡片及按钮均由原生组件呈现。

## 平台实现

Android 16 的实时通知使用系统标准布局：新角色大图标、状态色、短状态文字、`Notification.ProgressStyle` 和透明小梦进度跟踪图标。没有自定义 RemoteViews，也不启用 colorized，保留实时通知资格。未知进度使用不定进度；完成、离线、出错与待命不再申请提升为进行中的状态胶囊。

Android 7–15 的常驻通知，以及所有 Android 版本的审批、完成通知，使用深墨 RemoteViews 展开卡片。紧凑内容高 48dp；展开内容限制行数并保留原生系统头部和操作区。批准、拒绝、回复、查看任务仍使用既有 PendingIntent，真实审批权限和请求流程没有因设计稿而扩展。

设计稿的系统卡片、按钮外观和顶部胶囊是方向示意，无法逐像素控制系统模板。系统决定卡片底色、图标大小、操作按钮、是否提升及状态栏位置；厂商可能有额外条件。参见 [Android 实时通知要求](https://developer.android.com/develop/ui/views/notifications/live-update) 与 [自定义通知的尺寸约束](https://developer.android.com/develop/ui/views/notifications/custom-notification)。此轮实现针对现有 Android 应用，不改变尚未接入的 iOS Widget Extension 脚手架。

## 预览与验证

入口：应用设置 → 实时通知外观。页面明确标记示例数据，可切换四种状态。点击“发送系统预览通知”使用独立 tag/id，20 秒后清除；不会启动服务、提交审批或覆盖真实任务通知。系统通知权限关闭时给出反馈。

Flutter 测试覆盖状态切换、资源加载、离线时隐藏进度、320px / 大字体布局及预览 MethodChannel。设置 `LIVE_THEME_REVIEW_DIR` 可生成来自实际组件的截图；它们是外观预览截图，不是手机厂商的系统截图。Android 单元测试覆盖断线状态覆盖、任务优先级、进度边界与空摘要。

```powershell
cd app
flutter analyze --no-pub
flutter test --no-pub test/live_notification_theme_test.dart
flutter build apk --release --no-pub
cd android
./gradlew.bat :app:testDebugUnitTest
```

本机为 Windows，厂商流体云、Android 系统安装与通知显示仍需连接目标手机验证。请使用预览通知分别检查系统深浅色、字体放大、屏幕锁定及通知权限关闭场景。

### 本次结果

- `flutter analyze --no-pub`：无问题。
- Flutter 全量测试：76 项通过、1 项按现有条件跳过；外观截图专项 2 项通过。
- `:app:testDebugUnitTest`：4 项原生状态测试通过。
- `flutter build apk --release --no-pub`：成功；2.0.4 / versionCode 19，91,885,695 字节。没有运行 pnpm。
- [测试 APK](../../output/app/xiaomeng-v2.0.4-build19-android.apk) 与 [SHA-256](../../output/app/xiaomeng-v2.0.4-build19-android.apk.sha256)。沿用已有 Android Debug 签名，签名校验通过；未上传 GitHub。
- [运行状态实际组件截图](implementation/running.png)、[待确认](implementation/approval.png)、[完成](implementation/completed.png)、[离线](implementation/offline.png)。
