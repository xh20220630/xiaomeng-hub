# 小梦 · 云朵工作室动效

## 感受与节奏

角色有一点重量，界面保持轻盈。主要动作只在进入或真实状态变化时播放一次。阅读输出时不持续晃动，不用动画假装任务正在推进。角色与内容分工：角色传达情绪，状态文字负责准确表达连接和任务状态。

| 场景 | 动作 | 时长 |
| --- | --- | --- |
| 首页角色进入 | 轻落 16 px，微微展开至原尺寸 | 780 ms |
| 开始工作 | 上浮 4 px，轻摆后回到静止 | 780 ms |
| 等待确认 | 轻轻侧头 3° | 780 ms |
| 完成 | 单次 13 px 小跳，放大 5.5% | 780 ms |
| 出现异常 | 单次极轻左右摇头，最大 3 px | 780 ms |
| 空闲 | 下沉 3 px 后回到静止 | 780 ms |
| 卡片进入 | 12 px 位移与渐显 | 520 ms |
| 按下按钮 | 缩小到 97%，释放后还原 | 160 ms |

不得对输出中每一个文本增量更新 `trigger`，否则会反复触发角色动作。列表中的小尺寸头像建议保持静止，首页主角色或会话状态角色使用动效即可。`MascotImage(floaty: true)` 已统一使用这里的有限时状态动效，不叠加循环。

## Flutter 集成

文件：`app/lib/theme/motion.dart`、`app/lib/widgets/mascot_motion.dart`。

```dart
MascotMotion(
  cue: MascotMotionCue.welcome,
  child: MascotImage(MascotMood.main, size: 184),
)

MotionReveal(
  delay: const Duration(milliseconds: 60),
  child: contentCard,
)

MotionPress(child: FilledButton(onPressed: submit, child: Text('发送')))
```

`MascotMotion` 首次挂载播放一次；`cue` 或显式 `trigger` 变化时重播。普通 rebuild 不重播。`MotionReveal` 首次挂载播放一次。`MotionPress` 只观察指针，不替换内层按钮的点击、键盘和无障碍语义。

所有组件遵守系统 `MediaQuery.disableAnimations`、`TickerMode` 以及 `STATIC_CAPTURE`。关闭动画时直接展示最终状态。计时器在组件销毁时取消，无循环 ticker。

## Blender 星轨素材

实际使用本机 `D:\app\blender\blender.exe`（Blender 5.2.1 LTS）制作并渲染：

- `app/assets/motion/dream-orbit.png`：768 × 768 RGBA 透明 PNG，约 205 KB。中心与四角透明，细香槟金轨道、三颗星、两颗珍珠；可放于首页 IP 背后。
- `scripts/design/motion-star-orbit.blend`：可编辑源，48 帧、24 fps、物体位置与旋转关键帧。
- `scripts/design/motion-star-orbit.py`：可重复创建场景并渲染海报的脚本。

建议显示宽度 210–260 px，弱化存在感，避免放在正文或输入框后。透明装饰没有信息语义，Flutter 使用 `excludeFromSemantics: true`。运行时使用 PNG 与原生动效，不自动下载或播放视频；`.blend` 不打包进 App。

复现命令：

```powershell
& 'D:\app\blender\blender.exe' --background --python scripts/design/motion-star-orbit.py
```

## 验证

动效独立检查 4 项全部通过：各角色状态都能结束、普通重建不会重播、减少动画立即可见且没有活动 ticker、延迟入场销毁不会遗留回调、按压效果保留原生按钮点击。检查在仓库外的临时 QA 工程运行，临时测试已清理，不在仓库留下测试输出或构建缓存。

星轨素材经过奶白、可可和棋盘三底检查：alpha 范围 0–255，四边全透明，无背景框；内容范围为 `(33,166)–(727,605)`。
