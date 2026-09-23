# 小梦 UI v3 · 卡片与 IP 精修

2026-09-19。入口：[改版前后与完整页面](../index.html)。这里的页面截图来自实际 Flutter 组件和隔离测试数据。

## 视觉与实现

- 侧栏：恢复角色展示和「灵感，随时在场。」；统一会话、项目、收件箱、归档四个入口。工作空间与主机状态单独分组，新建会话置于品牌栏；整栏可滚动，窄屏大字体仍可访问底部设置。
- 项目：标题在主视觉上方，封面采用小梦工作与抱星球两种场景。图片铺满卡片顶部，移除多余文件夹栏及嵌套圆角。封面按项目 ID 稳定选择；标题、路径、待确认与运行数量使用实际数据。
- 卡片：普通卡片 12px、主视觉 16px、按钮 10px、输入区 12px、状态标签 6px、弹层顶角 18px。会话、项目、主机、设置、配对页、聊天、工具记录和模型选择使用同一尺寸体系。
- 层次：细边框与留白替代大面积彩色底板；减少大胶囊和重复装饰图标。保留首页原有 Blender 角色动画。
- 导航：四枚新 IP 图标使用有限时轻缩放，选中状态保持；支持减少动态效果，后台停止过渡。侧栏与主机、会话卡片同步使用同源图标。
- 业务：没有增加设计图里的示意能力、审批权限或附件；既有连接、会话、搜索、审批和模型交互继续使用原流程。

## 出图与素材

- [侧栏 / 项目设计稿](redesign-board.png)
- [六类卡片设计稿](cards-board.png)
- [三色底与 32px 图标验收](icon-review.png)
- [素材清单](asset-manifest.json)
- `assets/` 保留独立原图，运行素材位于 `app/assets/ui-v3/`，六枚图标均为 256 × 256 RGBA PNG，两张项目封面为 900 × 600 PNG。
- 使用内置 imagegen，引用既有瓷白小梦作为身份参考，每张素材独立生成。主机图标首轮输出为不透明棋盘格，重新出图后才可纳入导出。
- 公共提示词：matte porcelain Xiaomeng bunny identity, two rounded ears, black oval eyes, pale lime accent, restrained silhouette, no text, no glow, no surrounding tile；图标要求 actual transparent alpha，封面为 sage / warm porcelain 场景。
- `scripts/design/package-refinement.cjs` 使用 Sharp 统一导出尺寸，并组装导航图集和三色底验收。`before/` 保留此前 15 张实际截图。

设计稿中的文字、数量与状态仅为示意。不要据此扩展产品权限、模型目录或连接协议。

## 验证

### 2026-09-20 安装包

[下载 2.0.2（17）Android Release 通用包](../../../output/ui-v3/xiaomeng-2.0.2-17-android.apk)，93,212,200 字节，支持 arm64-v8a、armeabi-v7a、x86_64，最低 Android 7.0（API 24）。

`flutter build apk --release --no-pub` 成功。包名、版本、APK 签名及 10 个新增 UI 素材均已核对；签名与上一版 2.0.1（16）一致。本次打包未重跑 lint／类型检查及测试，之前的 UI 验证记录如下。[SHA-256 校验文件](../../../output/ui-v3/xiaomeng-2.0.2-17-android.apk.sha256)。

### 2026-09-19 UI 验证

- `flutter analyze --no-pub`：通过，包含 Dart 类型检查与 lint。
- `flutter test --no-pub --dart-define=STATIC_CAPTURE=true --dart-define=UI_REVIEW_DIR=../design/ui-v3/implementation`：54 项通过，7 项依赖真实动画的用例按配置跳过。
- `flutter test --no-pub test/dream_navigation_test.dart test/dream_motion_test.dart test/blender_intro_art_test.dart`：正常动画模式 15 项通过，覆盖选中保持、快速切换、减少动态效果及页面场景切换。
- 最后一次侧栏密度调整后，重新运行全页截图测试并通过。18 张截图已更新，手机 390 × 844、桌面 1440 × 1000、窄屏 320 × 700 / 1.4 倍字体；检查了侧栏底部可达性、全部入口与实际素材。总览见 [18 页联系表](../implementation-contact.jpg)。
- 六枚独立图标校验真实 alpha，三种底色与 32px 显示已视觉复核；预览页脚本完成离线执行和链接检查。
- 本轮未运行 build、未制作新的 APK，未运行 pnpm。新增测试缓存已移出工作区，原有构建产物保留。

工作目录没有 Git 仓库；改动前 lib、pubspec、原预览页及截图测试备份于 `C:/Users/Administrator/AppData/Local/Temp/xiaomeng-ui-refine-20260919-161127`。
