# 小梦 · 夜航工作室 UI 实现

> 2026-09-19 已完成侧栏、项目卡片及全局圆角精修，并接入独立 IP 图标。请查看 [当前交付与验证记录](refinement/README.md) 和 [改版对照](index.html)。2026-09-20 已生成 [最新版 2.0.2（17）Android 安装包](../../output/ui-v3/xiaomeng-2.0.2-17-android.apk)，下文其他 APK 属于先前版本。

2026-09-17。主 agent 完成 Flutter 落地；设计、规范切图、动效由三个独立子 agent 交付。

## 交付入口

- [集中预览](index.html)：14 张原始设计图、15 张实际 Flutter 页面截图、三色底素材检查。
- [设计规范与完整生成提示词](DESIGN.md)：内置 imagegen 生成，各页图片可单独查看。
- [实际界面总览](implementation-contact.jpg)。
- [素材清单](../../app/assets/ui-v3/asset-manifest.json)：10 张正式 PNG，8 张真实透明素材，2 张保留场景背景的项目封面，总计约 3.4 MiB。
- [动效文档](MOTION.md)：原生 Flutter 交互；首页角色现已增加 Blender 制作的透明循环动画，制作细节见 [Blender 动效](BLENDER-MOTION.md)。
- [Android 调试安装包](../../output/ui-v3/xiaomeng-night-studio-debug.apk)：约 159 MiB，2.0.0+13。

安装包 SHA-256：`C8D062F4E7C390846B8765FEAE62A4A7A61D317E2D033AA59A8181D0B7E7488A`。

## 实现内容

- 瓷白、深墨、青柠视觉系统及共享主题；使用本机字体回退，不新增在线字体请求。
- 会话首页：角色 hero、连接入口、搜索、状态筛选、原生任务卡、四入口悬浮导航。
- 项目页：插画与自适应网格封面；保留真实项目身份、路径、会话数和 Agent 筛选。
- 收件箱、归档：独立插画与信息层级；收件箱纳入待回复任务，并可从请求摘要打开原审批流程。
- 主机管理：按设备分组，展示真实在线状态、任务数和宿主机声明的能力。
- 连接设置：分组表单、令牌显示切换、测试连接、保存并重连和原 Android 通知诊断。
- 会话详情：来源状态区、sage 用户气泡、白色回复区、工具记录、浮动输入区。
- 新建会话、模型设置、审批、会话切换与导航抽屉使用同一主题。审批按钮改为具备标准键盘/辅助功能语义的原生按钮。
- 宽屏保留导航；打开会话后显示导航、任务列表、详情三栏。
- 接入入场、轻按、漂浮、在线呼吸与状态切换。首页插画离开视口后停止循环；遵守系统减少动态效果与静态截图模式。
- 首页角色使用 Blender 重新建模，提供 4 秒透明循环、点击轻弹与星光反馈；后台与离屏暂停，减少动态效果时使用静帧。此前删除的英文装饰文案保持删除。

文字、表单、操作和状态均是原生 Flutter 组件。概念图中的示例模型、预览附件、数量、能力与额外操作不作为硬编码产品数据。

## 验证

- `flutter analyze --no-pub`：无问题（包含 lint 与 Dart 静态类型检查）。
- `flutter test --no-pub --dart-define=STATIC_CAPTURE=true`：45 项通过。
- `flutter test --no-pub test/dream_motion_test.dart`：9 项正常动画模式测试通过。
- 实际截图测试覆盖 390 × 844 手机、1440 × 1000 桌面，以及 320px 宽 / 1.4 倍字体；使用真实图片和产品组件。
- 已覆盖搜索、Agent 隔离、消息追加、只读权限、审批回复、模型确认、消息分页、滚动位置、键盘遮挡等既有回归。
- `flutter build apk --debug --no-pub`：成功。
- 未运行 pnpm。未进行真机连接真实 Agent 的端到端验收；截图数据来自隔离测试 fixture，不会发送消息或执行审批。

重新生成截图：

```powershell
cd app
flutter test --no-pub --dart-define=STATIC_CAPTURE=true --dart-define=UI_REVIEW_DIR=../design/ui-v3/implementation test/ui_v3_review_test.dart
```

本工作目录没有 Git 仓库。改动前的 lib 与 pubspec.yaml 已保存到外部备份 `C:/Users/Administrator/AppData/Local/Temp/xiaomeng-ui-before-20260917-220802`。
本轮新建的测试缓存与 Android debug 编译中间文件已转移到系统临时目录；既有 release 产物保留。
