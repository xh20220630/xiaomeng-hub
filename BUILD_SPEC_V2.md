> 历史规格：本文保留早期 Claude 版本的设计参考，目录与 API 已发生变化。当前平台接口以 README.md、docs/AGENT_PROTOCOL.md 和实际代码为准。

# Claude 任务管理器 v2 — 实现契约（给实现 Agent）

工程：`D:\cc_project`。前端 `app/`（Flutter + Riverpod 3.x + google_fonts），后端 `server/`（Node + node:sqlite + ws）。
本文件是各实现 Agent 的**唯一权威契约**。务必：① 只创建/修改你被分配的文件；② 复用下方"前端基础 API"，**不要**改 `theme/tokens.dart`、`models.dart`、`chat_builder.dart`、`state/monitor.dart`、`state/settings.dart`、`services/*`、`main.dart`、`util.dart`、`widgets/mascot.dart`（这些已写好，读它们获取精确签名）；③ 像素级对照高保真原型。

参考资料（只读）：`D:\cc_project\资源\高保真原型.dc.html`（F1/F2/F3 真值）、`资源\新功能线稿.dc.html`（file_edit 抽屉、IP）。

---

## 1. 前端基础 API（已就绪，直接用）

### 主题 `lib/theme/tokens.dart`
- `AppColors`：`primary #D97757` / `primaryDeep #B85C3A` / `primaryRejected #C98A76` / `halo #F3DDD1` / `ink #3A352F` / `bodySecondary #4A443C` / `userBubbleText #5C4A3F` / `textSecondary #7A7265` / `textSecondaryLight #8A8275` / `textPlaceholder #A39A8B` / `doneNameGray #6B6357` / `bg #FAF7F1` / `drawer #FDFCF9` / `card #FFFFFF` / `warmWhite #FBF8F2` / `timestampBg #EFE9DD` / `success #6F8F6A` / `greenLight #EAF0E8` / `doneRowBg #F6FAF4` / `codeGreen #9FB89A` / `danger #D98A7A` / `rejectCapsuleText #9A6A55` / `rejectCapsuleBg #F1E4DC` / `warnBarBg #FAEFE9` / `borderWarm #E4DDCF` / `borderDivider #ECE5D8` / `borderLight #F0EBE0` / `inputBorder #DDD5C7` / `stepDashedBorder #C9C0B0` / `checkboxBorder #B3A99A` / `codeBg #2F2A24` / `codeTitle #D9A78C` / `codeHighlight #E6C3AB` / `mascotPink #FBE0EE` / `scrim` / `diffAddBg` / `diffDelBg`。
- `AppFont.ui({size, weight, color, height, letterSpacing})` → Nunito。`AppFont.mono({size, weight, color, height})` → Space Mono（项目名/命令/路径/终端输出/diff 一律用 mono）。
- `AppRadii.card=18, tool=11, drawerTop=30, button=16, input=21, badge=20, codeBlock=13, timestamp=12`。

### 形象 `lib/widgets/mascot.dart`
- `MascotImage(MascotMood mood, {size, circleBg, floaty})`，`MascotImage.forStatus(status, {...})`。
- `enum MascotMood { running, approval, completed, error, idle, avatar, main, icon }`，`moodForStatus(status)`。
- 资产已在 `assets/mascot/`，pubspec 已声明。

### 模型 `lib/models.dart`
- `Session`, `TaskEvent(id,sessionId,hookEventName,toolName,status,summary,detail,ok,createdAt)`,
  `Project(projectId,name,cwd,status,activeSessionId,summary,progress{done,total},pendingApproval,lastEventAt)`,
  `Approval(approvalId,sessionId,projectId,kind['command'|'file_edit'],title,command,filePath,diff,risk['danger'|'normal'],options,createdAt,expiresAt,status)`。
- `Approval.isDanger / isExpired / isPending`。

### 会话→对话 `lib/chat_builder.dart`
- `enum ChatKind { timestamp, claudeText, userText, toolBash, toolEdit, capsuleWaiting, capsuleApproved, capsuleRejected, capsuleInfo }`
- `class ChatMessage(kind, {text, toolTitle, toolOutput, ok, active, createdAt, approvalId})`
- `List<ChatMessage> buildChat(List<TaskEvent> chronological, {Approval? pendingApproval})`（传**正序**事件）。

### 状态 `lib/state/monitor.dart`（Riverpod）
- `monitorProvider` → `MonitorState{ status(WsStatus), List<Project> get projects, List<Approval> get pendingApprovals, Map sessions, Map liveEvents }`。
- `ref.read(monitorProvider.notifier)` 方法：
  - `Future<bool> respondApproval(String approvalId, {required bool approve, String scope='once'})`（已含 WS 上行 + REST 回退 + 乐观移除）。
  - `void sendMessage(String sessionId, String text)`、`void sessionControl(String sessionId, String action)`、`void reconnect()`。
- `sessionEventsProvider(sessionId)` → `FutureProvider<List<TaskEvent>>`（newest-first；F2 用 `.reversed` 得正序后喂 `buildChat`）。
- `projectProvider(projectId)` → `Project?`。
- `WsStatus { connecting, connected, disconnected }`（`lib/services/ws_service.dart`）。

### 工具 `lib/util.dart`
- `shortId`, `timeAgo(ms)`(中文), `hms(ms)`, `projectNameFromCwd(cwd)`。

---

## 2. 导航契约（各屏构造签名，务必一致）

- `HomeScreen()`（`lib/screens/home_screen.dart`，F1）。
- `ProjectDetailScreen({required String projectId})`（`lib/screens/project_detail_screen.dart`，F2）。
- `Future<void> showApprovalDrawer(BuildContext context, WidgetRef ref, Approval approval)`（`lib/widgets/approval_drawer.dart`，F3）。
- F1 卡片点击 → `Navigator.push(MaterialPageRoute(builder: (_) => ProjectDetailScreen(projectId: p.projectId)))`。
- F2 "等待审批"胶囊点击 → `showApprovalDrawer(context, ref, project.pendingApproval!)`。

---

## 3. 通信协议（WebSocket，顶层 `type`）

下行（server→app，monitor 已处理，仅供后端 Agent 对齐）：
- `projects.snapshot {projects:Project[]}`、`project.update {project}`、`event.append {event:TaskEvent}`、
  `approval.request {approval:Approval}`、`approval.resolved {approvalId, by}`。
- 兼容旧：`snapshot {sessions}`、`event {event, session}`。

上行（app→server）：
- `approval.respond {approvalId, decision:'approve'|'reject', scope:'once'|'always'}`
- `message.send {sessionId, text}`、`session.control {sessionId, action}`。

Project/Approval/TaskEvent 的 JSON 字段名见 `models.dart` 的 `fromJson`（camelCase；同时兼容 snake_case）。`TaskEvent` 增字段 `detail`（命令/文件/输出行）、`ok`（bool 成功）。

---

## 4. 设计令牌速查（像素级，来自高保真原型）

字号/字重：大标题「我的项目」23/800；抽屉标题19/800；详情项目名(mono)15/700；首页卡项目名(mono)14/700；正文气泡13.5/600 行高1.5；分组标题13/800 letterSpacing .3；步骤标签10/700；工具块标题(mono)11/700、输出(mono)11/400；时间戳11/600；抽屉按钮15/800。
圆角：卡片/容器18；工具块11；代码块13；时间戳胶囊12；连接徽标20；抽屉顶30；抽屉按钮16；输入框21；发送键圆。
阴影：待处理卡 `0 4 14 rgba(217,119,87,.16)`；普通卡 `0 2 8 rgba(0,0,0,.04)`；抽屉 `0 -12 36 rgba(0,0,0,.26)`；批准按钮 `0 6 16 rgba(217,119,87,.36)`；等待胶囊 `0 4 12 rgba(217,119,87,.34)`+ring。
动效：pulse 1.4s（进行中点 opacity 1→.25）；floaty（已在 MascotImage）；ring 1.8s 外扩阴影（等待胶囊）。

---

## 5. 各屏需求

### F1 `home_screen.dart`（+ `widgets/project_card.dart`, `widgets/conn_badge.dart`）
顶栏：左 `MascotImage(MascotMood.avatar,size:34)` + 「我的项目」23/800 ink；右 `ConnBadge(status)`（已连接绿点+文字 bg greenLight radius20 `5x11`；连接中黄/离线红，文案随 WsStatus）。
Body：`watch(monitorProvider).projects` 分三组，**空组隐藏**，下拉刷新 `reconnect()`：
- **需要你处理**（`p.hasApproval` 或 `status=='needs_approval'`）：标题 `▲ 需要你处理 · N` 13/800 primaryDeep。卡片：bg card，`border 2px primary`，radius18，padding14，shadow待处理；左 `MascotImage(MascotMood.approval,46,floaty:true)` + 列(项目名 mono14/700 ink；副 `请求执行 …`/`p.pendingApproval?.command` 13/600 primaryDeep) + 右 `›` 22/700 primary。整组置顶。
- **进行中**（`status` running/waiting_input）：标题 `↻ 进行中 · N` 13/800 textSecondary。卡：border 1.5 borderWarm，radius18，padding `13x14`，shadow普通；左 `MascotImage(running,40)` + 列(名 mono14/700；副 `p.summary` 13/600 textSecondary) + 右**脉冲点** 8圆 primary（pulse 动画）。
- **今日完成**（done/ended）：标题 `✓ 今日完成 · N`。**单容器**白卡 radius18 overflow hidden，行 `padding 13x15` space-between，行间 `border-bottom 1px borderLight`（末行无）；左项目名 mono13/700、右状态 12/700 success（如 `✓ 已完成`，可用 summary）。首行 bg doneRowBg、名 ink；其余名 doneNameGray。
- 卡片点击 → ProjectDetailScreen。需要处理空时该组隐藏；可加"🎉 暂无待处理"空态仅当三组全空。

### F2 `project_detail_screen.dart`（+ `widgets/step_bar.dart`, `widgets/chat_widgets.dart`）
`watch(projectProvider(projectId))` 取 Project；`watch(sessionEventsProvider(project.activeSessionId))` 取事件，`.reversed.toList()` 正序后 `buildChat(...)`。
顶栏：`‹` 26/700 + `MascotImage.forStatus(status,32)` + 列(项目名 mono15/700 ink；状态副 12/600 primaryDeep，如「运行中 · 等待审批」) + `⋯` 22 textPlaceholder。border-bottom 1.5 borderDivider。
**StepBar**（`widgets/step_bar.dart`）：四阶段 规划→执行→审批→完成，吸顶，bg warmWhite，border-bottom 1.5 borderDivider，padding `14x18 13`。节点枚举态 `{done(绿16圆+白✓), active(赭18实+halo光环), activeHollow(白18+赭2px边+halo光环), pending(白16+dashed C9C0B0边), rejected(C98A76 18+白✕)}`，标签10/700（done→success，active→primaryDeep，其余→textPlaceholder）；连线 height2.5 radius2：done绿实、未达 stepPendingLine 灰、rejected入边 rejectLine。**态映射**：规划恒 done；status running→执行active/审批pending/完成pending；needs_approval→执行done/审批activeHollow/完成pending；done/ended→全 done（完成active）；rejected/paused→执行done/审批rejected/完成pending。
**对话**（`chat_widgets.dart` 提供各 ChatMessage 的 widget）：列 gap14 padding `16x16 10`，按 `buildChat` 渲染：
- timestamp：居中胶囊 11/600 textPlaceholder bg timestampBg radius12 `4x12`（用 `今天 ${hms}`）。
- userText：右气泡 bg halo radius `15 5 15 15` padding `11x14`，文字13.5/600 userBubbleText。
- claudeText：左行 `MascotImage(avatar,28)` + 气泡 bg card border1.5 borderDivider radius `5 15 15 15` padding `11x13`，文字13.5/600 bodySecondary 行高1.5。
- toolBash/toolEdit：`margin-left 37`，bg codeBg radius11 padding `11x13`；标题 mono11/700 codeTitle（`⚙ Bash · …` / `✎ Edit · …`，可用 `m.toolTitle`）；输出行 mono11/400（成功 codeGreen，失败 danger；`m.toolOutput`）；`active` 时显示"运行中"细节。
- capsuleWaiting：居中 pill bg primary radius16 `9x16` 13/700 白字（`● ${m.text}`），shadow+ring 动画，**点击** → `showApprovalDrawer(context, ref, project.pendingApproval!)`。
- capsuleApproved：绿胶囊 12/700 success bg greenLight。capsuleRejected：bg rejectCapsuleBg 文字 rejectCapsuleText。capsuleInfo：灰胶囊。
底部输入框：bg bg，border-top1.5 borderDivider，padding `11x16 16`；TextField flex h42 border1.5 inputBorder radius21 bg card，占位「回复 Claude…」；发送 42 圆 primary 白 `↑` → `ref.read(monitorProvider.notifier).sendMessage(project.activeSessionId!, text)`，清空输入。
新事件实时追加（provider 自动）；列表 reverse 显示并自动到底。

### F3 `widgets/approval_drawer.dart`
`Future<void> showApprovalDrawer(BuildContext context, WidgetRef ref, Approval a)`：用 `showModalBottomSheet`（isScrollControlled、barrierColor `AppColors.scrim`、圆角 drawerTop、bg drawer）。监听 `monitorProvider` 的 `approvals`：若该 `approvalId` 已不在（被他端处理/resolved）→ 自动 `Navigator.pop` 并提示「已在其他设备处理」。过期(`a.isExpired`)→按钮禁用 + 「已过期，请回电脑处理」。
顶部抓手 48x5 radius3 `#E0D8C9` 居中。
- **command**（`a.kind=='command'`）：头 `MascotImage(approval,58,floaty:true)` + (标题「小梦需要你批准」19/800 ink；副 `${项目名} · 执行命令` 13/600 textSecondaryLight)。代码块 bg codeBg radius13 padding `14x15`：`# Bash` mono11/400 textSecondaryLight + `a.command` mono14/700 codeHighlight。`a.isDanger`→警告条 bg warnBarBg radius11 padding `11x13`：`⚠` primary + 文案13/600 primaryDeep（用 `a.title` 或固定"此操作不可撤销"）。按钮行 gap12：拒绝(flex1 h54 border2 ink radius16 文字15/800 ink) / 批准并执行(flex1.3 h54 bg primary radius16 白15/800 shadow)。复选「本次会话内始终允许此类命令」(19方框 radius5 选中 primary+白✓) → 决定 scope。
  - 拒绝 → `ref.read(monitorProvider.notifier).respondApproval(a.approvalId, approve:false, scope: checked?'always':'once')` 然后 pop。批准 → `approve:true`。
- **file_edit**（`a.kind=='file_edit'`，参考线稿）：头 `MascotImage(approval,38)` + 标题「修改文件待批准」16/700。路径 `✎ ${a.filePath}` mono12/400 doneNameGray。diff 块 bg codeBg radius11 mono12/400 行高1.7：`@@`行 textSecondaryLight；删行 danger 底 diffDelBg；增行 codeGreen 底 diffAddBg（解析 `a.diff` 按行首 `+`/`-`/`@`）。三档单选(radio 19)：仅本次允许此修改 / 始终允许编辑此文件 / 拒绝。确认按钮满宽 h50 bg primary radius15 白15/700；下「查看完整 diff ›」13 textSecondaryLight。映射：选 1/2 → approve（scope once/always），选 3 → reject。

### F4/F5/F6 通知（`notifications` Agent）
见你的专属任务说明；不改前端基础 API，只**新增** `NotificationService` 方法（保持现有 `init/show` 不变）。

---

## 6. 后端契约（后端 Agent；主进程已自建，见下）
由主进程实现，Agent 不动 `server/`。
