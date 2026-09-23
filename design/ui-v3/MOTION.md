# 夜航工作室 · 动效规范

动效服务于状态辨识与触感：页面先安静展开，主角缓慢漂浮，运行状态轻微呼吸，操作结束后柔和收束。荧光青柠 `#D9F66F` 只出现在轨道光点和状态提示中。

实现文件：`app/lib/widgets/dream_motion.dart`。使用 Flutter 原生动画与 Canvas，不增加依赖或网络请求。

| 组件 | 行为 | 推荐位置 |
| --- | --- | --- |
| `DreamReveal` | 560 ms 淡入，上移 18 px，easeOutCubic | 页面标题、hero、首屏卡片分组 |
| `DreamPress` | 按下 110 ms 缩至 97%，松开 240 ms 柔和回弹 | 主按钮、项目卡片、底部导航入口 |
| `DreamFloat` | 4.8 s 往复，振幅 5 px | 独立透明主角切图 |
| `DreamStatusSwitcher` | 300 ms 淡入并从 94% 缩放至原尺寸，150 ms 淡出 | 运行/完成/等待状态、操作反馈 |
| `DreamActivityDot` | 2.4 s 呼吸环，中心圆点持续可见 | 正在运行、连接状态 |
| `DreamOrbitHero` | 9.6 s 单光点公转，主角 4.8 s 漂浮 | 首页主角、连接引导、完成场景 |

## 接入方式

```dart
DreamReveal(
  delay: const Duration(milliseconds: 80),
  child: taskCard,
)

DreamPress(
  enabled: canConnect,
  child: FilledButton(onPressed: connect, child: const Text('开始连接')),
)

SizedBox(
  width: 180,
  height: 180,
  child: DreamOrbitHero(
    active: heroVisible,
    child: Image.asset('assets/ui-v3/mascot.png', width: 150),
  ),
)

DreamStatusSwitcher(
  child: Text(status.label, key: ValueKey(status)),
)

DreamActivityDot(color: AppColors.success, active: isRunning)
```

图片路径为示例，主 agent 应替换为切图 agent 交付的实际路径。已有完整轨道的主角素材使用 `DreamFloat`，避免再叠一层轨道。

`DreamReveal.trigger` 只在值变化时重新播放，因此流式内容重建不会重复入场。首屏建议按区域以 60–90 ms 的延迟递增，最多错开 4 个区域，不给长列表每一项叠加延迟。

`DreamPress` 使用 `Listener` 观察指针，不注册竞争手势，不改变子控件点击、长按、滚动或辅助功能语义。禁用按钮时同步设置 `enabled: false`。支持多指按压，直到最后一个指针抬起才释放缩放。

`DreamStatusSwitcher` 的子控件需要稳定且随状态变化的 `Key`。旧状态退出期间禁用命中与辅助功能语义，避免交互到正在淡出的按钮。

`DreamOrbitHero` 需要有限宽高；轨道装饰忽略指针，主角内容保留正常交互。包含 `RepaintBoundary`，通过传入 `child` 避免逐帧重新构建主角图片。

## 动效预算与降级

- 每个页面最多使用一个持续漂浮 hero；状态呼吸只用于正在运行的内容。
- 导航隐藏页应使用 `TickerMode`。滚出视口但仍被保活的 hero 由页面传入 `active: false`，以停止持续动画。
- 所有组件使用现有 `AppMotion.enabled`，遵循 `MediaQuery.disableAnimations`、`kStaticCapture` 和 `TickerMode`。禁用时直接显示完整内容，循环控制器停止并恢复中性姿态。
- 延迟计时器及控制器均在销毁时释放。页面切换不保留后台循环。
- 不使用闪烁、大面积模糊、满屏粒子或会影响阅读的循环文字运动。
- 默认测试需要 `pumpAndSettle` 时，应启用静态捕获、减少动态效果或传入 `active: false`，因为可见的持续循环本身不会 settle。

## Blender 与验证

已只读确认本机 Blender：`D:/app/blender/blender.exe`，版本 `5.2.1 LTS`。本轮采用可响应交互与无障碍设置的原生 Flutter 动效；没有调用 Blender 渲染，没有增加视频播放器依赖。

已执行 `dart format lib/widgets/dream_motion.dart` 与针对性 `dart analyze lib/widgets/dream_motion.dart`，分析结果为 `No issues found!`。未运行全项目 build，未运行 pnpm。
