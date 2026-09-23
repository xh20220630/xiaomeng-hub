# 小梦 · Nightflight Studio

> 2026-09-19 更新：当前实现采用 [卡片与 IP 精修规范](refinement/README.md)。下文的 24–32px 圆角与原始设计图保留为历史参考；现行普通卡片 12px、主视觉 16px、按钮 10px、弹层 18px。

2026-09-17 全页面视觉设计。设计图由内置 `image_gen` 逐页生成并人工视觉检查；这不是现有产品截图。图片数据、模型名和会话文案用于展示，应用必须继续使用真实服务数据和权限。

## 设计方向

以深墨、瓷白、荧光青柠构成温柔但有力量的远程创作空间。深墨区域承载品牌与角色，瓷白区域承载实际工作内容，青柠用于主要动作和当前选中项。3D 视觉只出现在 hero、项目封面、空状态与头像，读写内容、按钮、导航和状态保持原生可交互。

设计结合当代移动 UI 的克制留白、局部触感深度、底部触达和有目的的微动效。趋势参考：[Lazarev 2026 UI trends](https://www.lazarev.agency/articles/ui-trends-2026)、[Muzli mobile UI patterns](https://muz.li/blog/whats-changing-in-mobile-app-design-ui-patterns-that-matter-in-2026/)。设计的具体视觉语言和版式是本项目独立构建。

## 页面与图片映射

| 图片 | 实际入口 | 核心结构 |
|---|---|---|
| [01-conversations.png](01-conversations.png) | HomeScreen / 会话 | 深墨角色 hero、搜索、筛选、任务卡、悬浮导航 |
| [02-projects.png](02-projects.png) | HomeScreen / 项目 | 编辑式标题、文件夹 hero、项目封面、项目状态 |
| [03-inbox.png](03-inbox.png) | HomeScreen / 收件箱 | 信箱插图、待确认/更新分区、审批摘要 |
| [04-archive.png](04-archive.png) | HomeScreen / 归档 | 存档盒 hero、搜索、按时间归类的会话 |
| [05-agents.png](05-agents.png) | AgentsScreen | 在线概览、主机分组、Agent 卡、能力标签 |
| [06-settings.png](06-settings.png) | SettingsScreen | 链环插图、连接状态、主机表单、测试与保存 |
| [07-conversation-detail.png](07-conversation-detail.png) | ProjectDetailScreen | 紧凑状态栏、聊天、工具时间线、输入栏 |
| [08-new-conversation.png](08-new-conversation.png) | 新建会话 bottom sheet | 项目选择、任务输入、主动作 |
| [09-agent-settings.png](09-agent-settings.png) | AgentSettingsSheet | 模型、思考强度、协作模式与主机能力 |
| [10-approval.png](10-approval.png) | ApprovalDrawer | 操作上下文、代码/权限说明、动态决策按钮 |
| [11-navigation.png](11-navigation.png) | HomeScreen 导航抽屉 | 品牌、四个真实一级入口、项目、主机与设置 |
| [12-desktop.png](12-desktop.png) | HomeScreen 宽屏 | 深墨侧栏、会话列表、活动详情三栏 |
| [13-session-picker.png](13-session-picker.png) | 会话切换 sheet | 项目范围、会话列表、当前选择、新建入口 |
| [14-states.png](14-states.png) | 全局状态参考 | 空状态、离线、同步中 |

## Tokens

| 用途 | 数值 |
|---|---|
| 主背景 porcelain | `#F5F6F2` |
| 卡片 surface | `#FFFFFF` |
| 深墨 ink | `#11151B` |
| 深色次表面 | `#1B2129` |
| 主色 chartreuse | `#D9F66F` |
| 次背景 sage | `#E9EDDF` |
| 正文 | `#202620` |
| 次文字 | `#798077`，小字在浅底可加深至 `#656D65` |
| 细分隔 | `#E5E8E1` |
| 成功 | `#5C8551` |
| 等待/审批 | `#CA941F`，浅底 `#FFF2D9` |
| 危险 | `#B84C42`，浅底 `#FCEDEA` |
| 正文反白 | `#FFFFFF` |

青柠不承担浅底正文；按钮使用深墨文字。文本与图标保留清晰对比，状态同时提供文字/图形而不只靠颜色。

## 排版与尺寸

- 中文使用现有中文 sans 字体链，英文沿用同族，不引入无法离线加载的远程字体。大标题 28–32/600，页面标题 23–26/600，列表标题 15–17/600，正文 14–16/400，辅助信息 12–13/400。正文行高 1.45–1.65。
- 手机基准为 390 × 844，左右安全间距 20–24。小屏可收敛为 16，不能压缩触控目标。
- 主卡片圆角 24，紧凑卡片 18–20，hero 26–30，sheet 顶角 30–32，chip 与底部导航为胶囊。
- 间距使用 4、8、12、16、20、24、32、40。列表卡片之间 10–14，组之间 24–32。
- 主要按钮高 50–56，图标触控容器至少 44。筛选栏和 chip 允许横向滚动或换行。
- 首页 hero 的生成图为视觉展示，落地手机高度压到 240–280，确保首屏保留实际任务卡。其它页面 hero 约 120–160。
- 项目封面移动端可两列；内容不足、窄屏或较长动态标题时切成横向卡片，保持图像比例与可读文本。
- 宽屏沿用现有响应式边界。侧栏约 220–250，列表 340–430，详情吸收剩余空间。中等宽度缩减列数，避免三栏挤压。
- 详情页使用较低装饰密度；聊天、长文本、代码和审批说明必须可选中/滚动并正确换行。

## 角色与素材

角色是瓷白、略带薄荷环境反射的圆润小梦：两枚圆润长耳、黑色椭圆眼、小笑容、短手足，怀抱青柠星，hero 版本坐在深墨轨道上。材质为哑光陶瓷，使用柔和棚拍光，避免玩具包装和过强塑料反光。

透明素材规范与素材清单由切图 agent 维护在 [assets/README.md](assets/README.md)。运行时素材放 `app/assets/ui-v3/`。角色、信箱、文件夹、存档盒、电脑与链环适合 RGBA PNG；原生图标、文本、边框、阴影、布局、按钮不得整张截图替代。轨道已在角色图内时仅施加轻浮动，不叠第二套轨道。

动效参数与无障碍规则见 [MOTION.md](MOTION.md)。持续动效集中在 hero 和实际 running 状态；阅读内容保持静止。

## 生成图到产品的校正

1. 早期手机图底部第四项出现「我的」，实际产品统一使用「归档」。主机和设置放顶部状态入口与导航抽屉。
2. 图片中所有项目、会话、时间、数量、在线状态、命令和模型名都是示例，严禁硬编码成伪实时信息。
3. 详情图中的「首页预览」附件用于展示层次，未有真实附件时不显示该块。
4. 收件箱与审批图的按钮必须由当前 choice schema/权限决定。示意图「始终允许此类操作」不能被当成新授权能力。
5. 模型设置以主机 catalog 为准；不凭图片固定模型名称、推荐标签或思考等级。
6. 新会话建议 chip、搜索与复制控件只在已有功能或本轮实际实现时出现，不能放置无响应装饰操作。
7. 断线保留上次同步信息，不渲染假在线。空状态的主按钮依据真实可连接/可创建条件显示。
8. 3D 插画图片中偶有微小无关刻字或细节漂移；运行时统一使用经过边缘与透明度 QA 的切图。

## Prompt set

模式：内置 `image_gen.imagegen`，每页单独真实图片调用；未使用 CLI fallback。下面为可复现的最终视觉提示词规范，各页面在共同基底后追加对应指令。

共同基底：`Use case: ui-mockup. One production-quality polished Chinese mobile app full-screen UI screenshot for 小梦 AI Agent workspace, portrait 390x844 logical ratio, high resolution. No device frame or presentation surround. Nightflight Studio visual system: porcelain #F5F6F2 body, ink #11151B, luminous chartreuse #D9F66F, soft sage #E9EDDF, 24px gutters, 24px round cards, clean elegant Chinese sans, strong editorial typography, slim stroke icons, generous spacing. Tiny 9:41 status bar. Bottom floating ink rounded capsule nav. Avoid pink, purple, generic gradients and random decorative text.`

| 页面 | 追加 prompt 主题与精确主要文案 |
|---|---|
| 01 | Conversation HOME. Dark hero with porcelain rabbit hugging lime star on orbital ring. YOUR IDEAS, IN ORBIT. 灵感在此，持续发生。让每个想法，都有回响。3 个 Agent 在线。会话 / 新会话 / 搜索会话或项目 / 全部 / 进行中 / 待确认 / 已完成。Two spacious white task cards. |
| 02 | PROJECTS. YOUR CREATIVE SPACE. 想法有了自己的空间。Dark folder-and-star feature card. 正在发生 / 3 个项目，持续生长. Search and filters. Two-column sage 3D mint cube cluster and silver orbital sphere project covers. |
| 03 | INBOX. A LITTLE ATTENTION. 重要的事，刚刚好。Porcelain mailbox and lime envelope. 2 件事，等你确认。Amber shield approval card; npm run build dark code panel; 拒绝 / 允许执行. Update notification card. |
| 04 | ARCHIVE. GOOD WORK, KEPT SAFE. 每一次完成，都值得留下。Porcelain storage box with mint translucent lid. 留住灵感的轨迹。搜索归档会话。本周 / 更早 white completed task cards. |
| 05 | AGENTS. CONNECTED WORLDS. 你的创造力，不受距离限制。Dark 3D porcelain desktop monitor hero. 2 台主机 · 3 个 Agent 在线. Host groups, white agent cards, capability pills, 查看全部任务. |
| 06 | SETTINGS. 让小梦，找到你的电脑。Mint translucent link chain with matte dark ring. 当前已连接. White grouped actual inputs 主机地址 / 端口 / 访问令牌, 保存并重连 / 测试连接, current connection card. |
| 07 | CONVERSATION DETAIL. Compact title 打磨你的下一个好想法, running strip 正在创作, model pill, sage user bubble, assistant text, expandable completed-steps timeline, floating multiline composer with lime send arrow. |
| 08 | NEW CONVERSATION sheet. Dimmed home, porcelain 32px top corners, 开启新会话 / 把一个念头，变成下一步。Workspace selection, white large task input, suggestion chips, connection status, 发送并开始. |
| 09 | AGENT SETTINGS sheet. 模型与设置 / 为这次创作，找到合适的节奏。Grouped model radio list, thinking segmented control, collaboration mode, current Agent, 应用设置. |
| 10 | APPROVAL sheet. Amber shield, 需要你的确认 / 允许执行这一步吗？Operation metadata, BASH code npm run build, workdir, optional note, 拒绝 / 允许本次. Clear scope. |
| 11 | NAVIGATION drawer. 82% width ink drawer, 小梦 / NIGHTFLIGHT STUDIO, rabbit/star, 灵感，随时在场。会话 selected lime, 项目 / 收件箱 / 归档, 工作空间, online Agent panel and 连接设置. |
| 12 | DESKTOP. 16:10 landscape. Permanent dark 220px sidebar, center 420px conversation list, right active chat. Same brand/hero/cards/timeline/composer. Full screenshot without device frame. |
| 13 | SESSION PICKER sheet. 切换会话 / 同一个项目，不同的灵感轨迹。Workspace icon, search, Today/Yesterday groups, selected lime outlined conversation, 在此项目新建会话. |
| 14 | STATES landscape three-panel board. Empty conversation with porcelain rabbit and 开启新会话. Offline with 暂时没有连接 / 重试连接 / 检查连接设置. Syncing with skeleton cards and 正在同步你的工作空间. |

## 检查记录

14 张 PNG 均已保存到本目录并逐张视觉验看。页面结构、文字层级、色彩、主要控件和基本页面映射已检查。生成图部分品牌角色在弹层背景略有漂移，落地使用同源切图统一。未运行 lint/typecheck/build：本设计子任务仅创建 PNG 与设计说明，不编辑产品代码。
