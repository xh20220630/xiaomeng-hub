# 首页 Blender 动效

首页采用瓷白小梦抱着青柠星星的完整 3D 场景。Blender 负责角色、细金属轨道、珍珠卫星与循环动作；Flutter 负责播放及点击时的轻弹、星光回应。

## 文件

- `scripts/design/night-orbit-motion.py`：可重复运行的建模、动画和渲染脚本。
- `scripts/design/night-orbit-motion.blend`：可编辑场景与关键帧。
- `app/assets/motion/night-orbit-atlas.png`：8 列 × 6 行，48 帧，每帧 384 × 384，RGBA 真透明。
- `app/assets/motion/night-orbit-still.png`：加载中与减少动态效果使用的静帧。
- `app/lib/widgets/blender_mascot.dart`：4 秒循环播放、点击反馈、离屏与后台暂停。
- `design/ui-v3/motion-preview.gif`：夜色背景的循环预览。

动画帧只在帧号变化时更新，并通过 RepaintBoundary 隔离重绘。整张图集解码后的像素占用约 27 MiB，因此仅首页主角使用该动画，小头像保持静态；减少动态效果模式不加载动画图集。加载失败时保留静帧。

文字、按钮和会话列表仍由 Flutter 组件渲染。首页已删除的英文装饰文案不会通过动画重新引入。

## 验证方式

`flutter test --no-pub test/blender_mascot_test.dart` 覆盖帧尺寸与循环、离屏暂停与恢复、减少动态效果、后台暂停、连续点击与资源释放。

本次验证：4 项 Blender 播放器测试、9 项既有动效测试和页面截图/多尺寸布局测试通过；对改动的 Dart 文件做定向静态分析。未运行全量 lint/typecheck 或打包 build。Web 使用开发模式编译预览。

图集约 2.8 MB，alpha 范围 0–255，全透明像素占 73.79%，所有帧至少留有 29 px 边距。首尾相邻帧平均差约 1.8/255，与普通相邻帧约 1.7/255 接近；渲染检查数据保存在 `motion-preview-metrics.json`。

此更新接入本机 Web 预览。此前提供的 Android APK 是旧版本，未包含此次 Blender 动效。

## 底部导航

底部导航直接融入页面瓷白背景。移除悬浮卡片、圆角底座、阴影和选中背景板，只保留四个独立立体图标、中文标签及小圆点指示。

选中图标播放约600ms的状态转换，停留在第15帧；取消选中时约360ms反向收回到第0帧。重复点击当前项不会重播或退回未选中造型，快速切换从各图标当前进度继续。首次进入就显示正确选中造型，减少动态效果与后台暂停也保留选中状态。

四种选中造型：气泡变青柠并转正、文件夹展开露卡、信封升起、归档盒盖保持抬起。保留点击区域、键盘操作和待处理数量角标。

- `scripts/design/tabbar-motion.py` / `.blend`：四个模型与状态转换动画的可编辑源文件。
- `app/assets/motion/tabbar-atlas.png`：1024 × 1024、8 × 8、64帧，每个图标连续16帧，单帧128 × 128。
- `app/assets/motion/tabbar-still.png`：512 × 256，上排四个未选中状态，下排四个选中状态；减少动态效果时使用。
- `app/lib/widgets/dream_navigation.dart`：无卡片导航布局与各图标独立的可逆状态动画。
- `design/ui-v3/tabbar-preview.png`：上排未选中、下排选中造型对照。
- `design/ui-v3/tabbar-preview.gif`：浅底演示，包含选中后停留和取消选中反向收回。

透明边缘检查通过，所有帧至少有8px安全留白，四个图标首尾均明显不同，48px尺寸下也可辨认。三个导航测试覆盖初始选中态、完成后持续保持、快速切换反向衔接、重复点击不归位、320px窄屏与1.4倍字体、减少动态效果与角标。改动的Dart文件定向静态分析通过；未运行全量lint/typecheck/build，未重新打包APK。

## 项目、收件箱与归档顶部卡片

三个卡片使用独立的 Blender 微缩场景：项目文件夹里的青柠星星升起与转动、收件箱来信轻浮与信号珠绕行、归档收藏盒盖及星星缓缓起落。均为 48 帧、4 秒的透明循环。

- `scripts/design/page-intro-motion.py` / `.blend`：建模、动作与渲染源文件。
- `app/assets/motion/{project,inbox,archive}-intro-atlas.png`：每张 2048 × 1536，8 列 × 6 行，单帧 256 × 256。
- `app/assets/motion/{project,inbox,archive}-intro-still.png`：各场景静帧。
- `app/lib/widgets/blender_intro_art.dart`：按需加载当前场景，切换时释放旧场景引用，离屏或后台暂停；减少动态效果时只加载静帧。
- `design/ui-v3/page-intro-preview.gif`：三个场景的并列预览。

卡片文字、数量、页面操作和布局保持原有逻辑。动画解码像素每场景约 12 MiB，Flutter 图像缓存可保留最近使用的场景；仅当前显示的卡片播放，动画资源加载失败时回退到静帧与原插画。

验证命令：`flutter test --no-pub test/blender_intro_art_test.dart`；页面布局使用已有的 `ui_v3_review_test.dart`，以 `STATIC_CAPTURE=true` 检查真实资产与窄屏。

本次三个场景播放/切换/暂停测试、最终资产的页面布局检查与定向 Dart 静态分析均通过。三张图集合计约 3.3 MB，最小安全边距分别为 30、12、18 px，Alpha 均覆盖 0–255，首尾帧差异小于普通相邻帧差异。未运行全量 lint/typecheck/build，未重新打包 APK。
