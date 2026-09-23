# 小梦素材规范

## 视觉方向

「云朵工作室」使用奶杏、乳白与可可色构成界面，粉色用在角色与关键反馈。小梦保留蓝眼、卷耳、粉色星星触角、小翅膀、卷尾与金色彗星，新增插画采用柔雾瓷和软糖质感。

## 切图范围

- 位图：角色全身姿态、头像、独立装饰插画。
- 原生绘制：文字、按钮、输入框、菜单、标签、分割线、阴影与渐变。它们需要响应尺寸、交互状态和无障碍设置。
- 不将整个页面切成截图，不把文字烘焙到角色素材中。

## 文件和尺寸

| 类型 | 导出尺寸 | 内容留白 | 推荐显示尺寸 |
| --- | --- | --- | --- |
| Hero | 768 × 768 RGBA PNG | 至少 6% | 140–320 logical px |
| 状态图 | 384 × 384 RGBA PNG | 至少 6% | 64–160 logical px |
| 头像 | 160 × 160 RGBA PNG | 至少 6% | 24–64 logical px |

所有导出位于 `app/assets/mascot-v2/`。使用语义名称，原始旧素材不覆盖。`manifest.json` 记录每张导出的来源、裁切框、内容边界、透明占比与文件大小。

## 透明边缘和缩放

采用真实 alpha，不使用棋盘格背景。裁切只按 alpha 内容边界收紧画布，不将软边改成二值遮罩。缩放前使用预乘 alpha，缩放后恢复 RGBA，避免透明像素中的隐藏 RGB 形成白边。角色完整保留星星、翅膀和尾巴；头像可裁至胸部，但必须保留星星触角和双眼。

输出需在奶白底、深可可底和棋盘格三种背景检查。边缘无硬框、白边、残留色块；内容不得触及最终画布边缘。

## 原素材审计

现有 9 张素材均为 1254 × 1254 RGBA PNG，已有真透明背景。全身状态图原有留白较大，角色只占原画宽约 45–59%、高约 70–80%，直接缩到小组件后角色偏小。欢迎图含较多半透明水彩笔触，应保留原始 alpha。

| 旧素材 | 透明像素占比 | Alpha 内容边界 (left, top, right, bottom) |
| --- | --- | --- |
| approval | 82.01% | 288, 125, 931, 1102 |
| avatar | 60.19% | 139, 115, 1112, 1242 |
| completed | 79.60% | 236, 113, 978, 1119 |
| error | 83.96% | 337, 177, 900, 1061 |
| icon | 47.93% | 170, 148, 1084, 1085 |
| idle | 81.63% | 312, 112, 923, 1116 |
| main | 83.49% | 309, 130, 907, 1075 |
| running | 80.39% | 288, 136, 969, 1095 |
| welcome | 73.57% | 61, 21, 1182, 1182 |

待审批、闲置与出错沿用原 IP 的真实对应表情，经过相同的透明裁切和尺寸规范后分别导出为 `state-approval.png`、`state-idle.png` 与 `state-error.png`。欢迎、专注工作、完成庆祝与头像使用新版立体素材，manifest 的来源字段区分版本。

## 导出工具

`scripts/design/export_mascot.py` 使用 Pillow，支持 `--role hero|state|avatar`、`--inset` 与显式 `--crop left top right bottom`。默认保留所有非零 alpha 像素，透明源图必须经过检查。导出记录自动写入 manifest。

示例：

```text
python scripts/design/export_mascot.py SOURCE.png hero --role hero
python scripts/design/export_mascot.py SOURCE.png avatar --role avatar --crop 100 60 850 780
```

`scripts/design/verify_mascot.py --sheet OUTPUT.png` 验证 alpha、画布边界和可见内容，并生成奶白、深可可和棋盘格三底验收图。验收图应输出到临时目录，避免被作为运行素材打包。

## 已确认的生产处理

- `hero-welcome.png`：新版原图以 `(231, 3, 1030, 1233)` 收紧，仅去除远离角色的 alpha=1 游离像素。星星、翅膀、尾巴完整保留，最终补足 6% 画布留白。
- `avatar.png`：同一张原图裁 `(260, 0, 1005, 725)` 为头部与上半身。建议置于圆形或圆角头像容器，保留触角与完整双眼。
- `hero-celebrate.png` / `state-completed.png`：开心拥星原稿裁 `(211, 23, 1055, 1217)`，完整保留手中星星和尾巴彗星。
- `hero-working.png` / `state-running.png`：使用纯绿背景原稿，经 `scripts/design/key_green.py` 去底。中间母版为 `design/mascot-source/xiaomeng-working-alpha-v2.png`。仅对绿色混合边缘反算背景贡献并去除绿溢色；粉色、乳白、金色和蓝色主体完整保留。此工具针对这张无绿色主体的工作室色键板，不是通用照片背景移除工具。
- Blender 装饰 `app/assets/motion/dream-orbit.png` 已纳入 alpha 验证；768 × 768 RGBA，四边完全透明，内容边界为 `(33, 166, 727, 605)`。
- 曾出现 RGB 棋盘格背景的工作形态原稿，已拦截，未作为运行素材发布；正式工作态来自绿幕去底后的 RGBA 母版。

## 最终运行素材

| 文件 | 尺寸 | 形态与来源 |
| --- | --- | --- |
| hero-welcome.png | 768 × 768 | 新版立体，漂浮挥手 |
| hero-working.png | 768 × 768 | 新版立体，专注电脑 |
| hero-celebrate.png | 768 × 768 | 新版立体，开心拥星 |
| avatar.png | 160 × 160 | 新版立体，头部与上半身 |
| state-running.png | 384 × 384 | 新版立体，专注电脑 |
| state-completed.png | 384 × 384 | 新版立体，开心拥星 |
| state-approval.png | 384 × 384 | 原版，待审批 |
| state-error.png | 384 × 384 | 原版，遇到问题 |
| state-idle.png | 384 × 384 | 原版，待命 |

最终 9 张角色 PNG 约 1.25 MB，相比原 9 张 6.68 MB 更适合局域网 Web 首屏加载。所有文件 alpha 范围为 0–255，画布四边最大 alpha 为 0；奶白、深可可和棋盘三底已人工查看，无棋盘背景烘焙、明显白边或绿边。导出后主体未贴边。Blender 星环同样通过验收。

切图和验证工具依赖 Pillow；绿幕边缘解混工具额外使用 NumPy。生产导出后执行过透明和边界验证、三底视觉检查以及脚本语法编译检查；未由素材子任务运行 Flutter lint、typecheck 或 build。
