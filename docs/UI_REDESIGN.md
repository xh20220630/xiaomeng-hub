# 小梦：宿主机索引与会话界面

## v3 卡片与 IP 精修

侧栏补齐角色展示、工作空间与主机状态分组；项目页采用通栏小梦 IP 封面，统一 12px 卡片与 10px 按钮圆角。六枚透明 IP 图标用于侧栏、会话和主机卡片。设计稿、实际 Flutter 截图与改版前后对照见 [精修交付](../design/ui-v3/refinement/README.md)。

2026-09-23：底部 tabbar 恢复原有 Blender 制作的会话、项目、收件箱、归档四枚图标，使用 `app/assets/motion/tabbar-atlas.png` 与 `tabbar-still.png`。保留原版 46px 图标、90px 导航内容高度及选中上浮效果；选中时正向播放 16 帧并保持终态，取消选中时反向播放，减少动态效果时直接显示对应静态姿态。源文件为 `scripts/design/tabbar-motion.blend`，生成脚本为 `scripts/design/tabbar-motion.py`，动效见 [Blender tabbar 预览](../design/ui-v3/tabbar-preview.gif)。

## v2.0 云朵工作室

首页、项目、主机、会话和设置采用统一品牌视觉。新增三种立体 IP 形态、规范透明切图、Blender 星轨和有限时交互动效。完整实现、素材来源与验证记录见 [云朵工作室](design/implementation.md)。

## v1.6.2 输入操作

- 输入框只保留一个主操作按钮。任务运行且无待发送文字时显示停止；输入文字后显示追加指令；空闲时显示发送，空白消息不可发送。
- 正在运行的任务在右上角“会话操作”中保留停止入口，编辑草稿时仍可停止任务。

## v1.6.1 聊天分页与输入框

- 滚到历史消息顶部附近自动读取下一页；不足一屏时继续补齐，加载期间去重，失败保留当前位置并提供重试。
- 模型入口移到输入框内部的底部工具栏，与发送、停止并列。主机确认设置后更新模型名称，切换过程中保留草稿。
- 仅在消息内容变化时校正阅读位置，避免把用户的滚动动作误判为需要还原的位置。

## v1.6 输出流与阅读体验

- 最终回复独立排版，保留小梦头像；流式回复标注“正在生成”，完成后可复制全文。正文支持选择文字，代码块提供语言标签、横向滚动和独立复制。
- 公开进度说明、思考摘要和工具调用按轮次收拢为“执行记录”。运行时只预览最新进度与操作，完成后默认折叠。失败数量始终可见，审批和问题保留独立入口。
- 展开后显示可读的操作名称；点击操作打开适合手机的详情抽屉，分开查看输入、结果及完整原始文本。长记录按需展开，复制保留全文。
- Codex 的 `phase`、轮次与消息标识贯穿历史与实时协议，区分进度和最终回复；其他适配器可提供相同可选字段，未标记的助手文字继续作为回复显示。
- 流式输出按消息标识合并，已结束工具不会被迟到的输出恢复为运行状态。列表使用稳定键；浏览历史时提供“回到最新”，避免每个增量都强制滚动。
- 执行记录先渲染最近 12 条，按需加载更早记录，减少大段日志和控件的初始布局成本。
- 宿主机附带的浏览器环境说明与附件路径从用户消息的默认阅读区收起，实际指令优先显示；“查看原始消息”保留完整上下文。

视觉参考：[Codex app](https://openai.com/index/introducing-the-codex-app/)。以正文阅读、进度概览和按需检查为层级，品牌素材沿用小梦。

## 体验设计

- 以会话为首页，侧栏保留项目、待处理、归档、主机与连接和设置。手机使用抽屉导航，桌面保留固定侧栏。
- 白色与浅灰为主，深色用于主要操作；粉色只用于小梦 IP 和需要关注的提示。
- 正文居中，保留阅读宽度；用户消息使用浅灰气泡，助手回复直接排版，工具结果独立折叠。
- 最近消息先加载，上滑接近顶部时通过游标自动读取较早消息。列表惰性渲染，更新局限于当前会话，不再反复强制滚到底部。
- 任务操作沿用能力约束。归档任务只读；Codex 桌面持有的任务通过同用户 IPC 控制，终端任务可连接共享 App Server。
- v1.5 在会话来源旁增加“模型与主机能力”：真实模型目录、推理强度、工作模式、主机确认提示和能力查询，适配手机底部抽屉。

## 本机验证

2026-09-16 使用 codex-cli 0.154.0：读取 293 个会话（含 4 个归档）、11 个已保存项目，合计 98 个项目与历史工作目录分组。后续任务变化会更新这些数字。

主机上的 `state_*.sqlite` 和 `thread_history_*.sqlite` 仅用于补充项目、会话和轮次状态元数据，以只读方式打开；消息正文从官方 App Server 分页读取。普通 ChatGPT 云端聊天不包含在这个本地数据源中。

## IP 素材

新素材：`app/assets/mascot/mascot-welcome.png`。用于首页和空会话，占据小面积，避免遮挡任务内容。保留原有头像、工作与等待状态素材。

生成方式：内置 ImageGen，以现有小梦角色图为参考。可复用提示词：

> Preserve the exact Xiaomeng mascot identity from the reference: soft pink creature, blue eyes, star antenna, small wings, curled tail and golden comet accent. Create a premium soft watercolor illustration of Xiaomeng beside a small clean white laptop. Friendly, calm and focused, delicate painted texture, generous negative space, isolated on a transparent background. No text, no letters, no logos, no extra characters. Maintain the original proportions and facial features.

文字排版、图标、气泡和导航由 Flutter 实现，插画只承担品牌与情绪表达。
