> 历史文档：Android 当前由原生 MonitorService 维护连接和通知，本文部分 Dart 通知接线描述已过时。平台能力与接口见项目 README 和 docs/AGENT_PROTOCOL.md。

# 通知与 Live Activity（F4 / F5.1 / F5.2）

本文档说明 Claude 任务管理器 App 的两条"离开应用也能处理审批"的通道：

- **Android 常驻通知 + 内联动作（批准 / 拒绝）** —— 已实现、可编译。
- **iOS 灵动岛 / 锁屏 Live Activity（ActivityKit + App Intents + APNs Live Activity push）** —— 已搭好脚手架，等待在 macOS/Xcode 上落地。

> 诚实声明：当前开发机为 **Windows**，没有 Xcode / Apple 工具链，**iOS 部分无法在本机构建或验证**。下方 iOS 章节是设计与接线清单，标注了所有 `TODO(ios)`。Windows 上仍可正常 `flutter analyze` / 构建 Web 与 Android：Live Activity 的 Dart 侧（`MethodChannel` 占位）在非 iOS 平台是优雅降级的 no-op，不进入构建链路的 Swift 文件也不参与 web/analyze。

---

## 1. 相关文件一览

可编译（参与 Dart 构建）：

- `lib/services/notifications/notification_service.dart` —— 抽象接口，新增 `showApproval({approvalId, title, body})`（`init` / `show` 签名未改）。
- `lib/services/notifications/notification_service_io.dart` —— 原生实现（flutter_local_notifications v22）。Android 用两个 `AndroidNotificationAction` 配「批准 / 拒绝」。
- `lib/services/notifications/notification_service_stub.dart` —— Web 空实现。
- `lib/services/notifications/notification_factory.dart` —— 条件导入选择实现（未改）。
- `lib/services/live_activity/live_activity_channel.dart` —— Live Activity 的 Dart `MethodChannel` 占位（`start` / `update` / `end`），非 iOS 与未注册原生处理时为 no-op。

脚手架（仅在 macOS/Xcode 上参与 iOS 构建，**不影响 web/analyze/Android**）：

- `ios/ClaudeActivityWidget/ClaudeActivityAttributes.swift` —— `ActivityAttributes` + `ContentState` 数据契约。
- `ios/ClaudeActivityWidget/ClaudeActivityWidget.swift` —— 紧凑 / 展开 / 锁屏视图（`DynamicIsland` + Lock Screen）。
- `ios/ClaudeActivityWidget/ClaudeApprovalIntents.swift` —— 批准 / 拒绝 App Intents 占位。
- `ios/ClaudeActivityWidget/ClaudeActivityBundle.swift` —— `WidgetBundle` 入口。
- `ios/ClaudeActivityWidget/ClaudeActivityController.swift` —— Runner 侧 ActivityKit 控制器，桥接 `MethodChannel`。
- `ios/ClaudeActivityWidget/Info.plist` —— 扩展 Info.plist（含 `NSSupportsLiveActivities`）。

---

## 2. Android 常驻通知 + 动作（F5.2，已实现）

### 工作方式

1. 当 WS 下行 `approval.request` 到达，`MonitorNotifier`（`lib/state/monitor.dart`）已经在调用 `notificationServiceProvider.show(...)` 弹出一条普通审批提醒。要把它升级成**带动作的常驻通知**，调用新接口：

   ```dart
   ref.read(notificationServiceProvider).showApproval(
     approvalId: a.approvalId,
     title: '🔔 需要审批',
     body: a.title,
   );
   ```

2. `notification_service_io.dart` 在专用频道 `claude_approvals` 上发出通知：
   - `importance: Importance.max` / `priority: Priority.high` —— 抬头横幅 + 锁屏可见。
   - `ongoing: true` + `autoCancel: false` —— 在用户做出决定前**常驻**（不可滑掉），避免错过审批。
   - 两个 `AndroidNotificationAction`：
     - actionId `approve`，标题「批准」；
     - actionId `reject`，标题「拒绝」；
     - 均 `showsUserInterface: false`（内联响应，不必拉起整个 App）+ `cancelNotification: true`（点完即收起）。
   - 通知 id 由 `approvalId.hashCode` 派生，便于后续按同一审批 cancel / 覆盖。
   - `payload` 形如 `approve:<approvalId>`，body 点击（打开 App）时可解码定位审批。

### 启用（接线清单）

> 这一步属于"基础 API / main.dart"范畴，不在本 Agent 的可改文件内；这里给出**对接说明**，供负责 `main.dart` 的同学落地。

- 初始化 `flutter_local_notifications` 时设置动作回调：

  ```dart
  await _plugin.initialize(
    settings: settings,
    onDidReceiveNotificationResponse: _onAction,        // 前台/后台点击
    onDidReceiveBackgroundNotificationResponse: _onBgAction, // 顶层函数，App 被杀时
  );
  ```

- 回调里按 `response.actionId` 路由（`approve` / `reject`），从 payload 取出 `approvalId`：

  ```dart
  void _onAction(NotificationResponse r) {
    final approve = r.actionId == 'approve';
    final id = (r.payload ?? '').split(':').last;
    if (id.isEmpty) return;
    ref.read(monitorProvider.notifier)
       .respondApproval(id, approve: approve, scope: 'once');
  }
  ```

  > `respondApproval` 已自带「WS 上行 + REST 回退 + 乐观移除」（见 `monitor.dart`），所以动作回调只需调用它即可。

- `onDidReceiveBackgroundNotificationResponse` 必须是**顶层或 static 函数**并加 `@pragma('vm:entry-point')`；它运行在独立后台 isolate（见第 4 节）。

- AndroidManifest：v22 已自动声明 action 接收器，无需手动注册 receiver；如要 App 被杀后台直接落库/上报，可在该后台 isolate 内走 REST（`ApiService.resolveApproval`）。

### Android 13+ 权限

`init()` 已在 Android 上调用 `requestNotificationsPermission()`。`ongoing` 常驻通知不需要额外权限；若将来要在 App 被杀后**主动**唤醒，请配合 FCM（见第 4 节）。

---

## 3. iOS 灵动岛 / 锁屏 Live Activity（F4 / F5.1，脚手架）

### 目标形态

- **灵动岛紧凑态**：左侧相位图标（运行中 / 待审批 / 完成 / 错误），右侧短状态文案。
- **灵动岛展开态**：项目名 + 状态 + 待审批时的「批准 / 拒绝」按钮（App Intents）。
- **锁屏 / 横幅**：项目名 + 状态 + 详情行 + 待审批时的批准 / 拒绝按钮。

视图与配色见 `ClaudeActivityWidget.swift`，配色对齐暖纸主题（primary `#D97757`、ink `#3A352F`、success `#6F8F6A`、danger `#D98A7A`）。

### 数据流

```
Flutter (monitor 收到 approval.request / 任务运行中)
   └─ LiveActivityChannel.start/update/end   (lib/services/live_activity/…)
        └─ MethodChannel "app.claude.monitor/live_activity"
             └─ ClaudeActivityController (ios/…/ClaudeActivityController.swift)
                  └─ ActivityKit  Activity<ClaudeActivityAttributes>.request/update/end
                       └─ WidgetKit 渲染灵动岛 + 锁屏 (ClaudeActivityWidget.swift)
                            └─ 用户点「批准/拒绝」→ App Intents (ClaudeApprovalIntents.swift)
                                 └─ POST 审批决定到 bridge server（同 respondApproval 的 REST 路径）
```

### 接线清单（macOS/Xcode 上落地，全部标注 `TODO(ios)`）

1. **新建 Widget Extension target** `ClaudeActivityWidget`，把 `ios/ClaudeActivityWidget/*.swift` 与 `Info.plist` 加入该 target（`ClaudeActivityController.swift` 加入 **Runner** target，其余加入扩展 target）。
2. **Runner/Info.plist** 增加 `NSSupportsLiveActivities = YES`（扩展的 Info.plist 已含）。
3. **AppDelegate.swift** 注册 `FlutterMethodChannel("app.claude.monitor/live_activity")`，把 `start/update/end` 转发到 `ClaudeActivityController.shared`（控制器内已写好示例 handler 代码块）。
4. **App Intents**：iOS 17+ 用 `Button(intent:)` 在 Live Activity 内直接执行 `Approve/RejectApprovalIntent`；iOS 16.x 不支持交互按钮，降级为点按深链 `claudemonitor://session/<id>` 拉起 App 内审批抽屉。
5. **App Group**（建议）：让扩展的 App Intent 与主 App 共享 baseUrl / 凭据，便于在 Intent 内直接发起审批 REST。
6. **APNs Live Activity push（远程更新）**：
   - `Activity.request(..., pushType: .token)` 获取 push token；
   - 把 token 上报 bridge server；
   - server 通过 APNs 的 `liveactivity` 推送主题更新 `ContentState`（即使 App 在后台/被挂起也能刷新灵动岛与锁屏）；
   - 这条通道是"App 不在前台时审批仍能实时出现在灵动岛"的关键。

### 为什么 iOS 不复用 Android 的内联通知动作

iOS 普通本地通知的可操作按钮（`UNNotificationAction`）能力有限且不能常驻；灵动岛 / 锁屏 Live Activity 才是 iOS 上"任务进行中 + 内联审批"的原生范式，所以 iOS 走 ActivityKit + App Intents，而 `showApproval` 在 iOS 上仅作为一条 `timeSensitive` 兜底提醒。

---

## 4. App 被杀死时的后台审批：为什么需要 FCM / 后台 isolate

无论 Android 还是 iOS，**进程被系统回收后，App 自己的 WebSocket 连接就断了**，不可能继续收到 `approval.request`。要保证"人不在 App 里、甚至 App 被杀，也能及时收到并处理审批"，必须借助系统级的推送 / 后台执行机制：

- **Android**：
  - 远程唤醒用 **FCM（Firebase Cloud Messaging）** 高优先级 data 消息：bridge server 在产生审批时推送，系统在 App 被杀时仍会拉起一个**后台 isolate** 处理回调。
  - 在该后台 isolate（`onDidReceiveBackgroundNotificationResponse` / FCM background handler，均需 `@pragma('vm:entry-point')` 的顶层函数）里弹出本文第 2 节的常驻动作通知；用户点「批准 / 拒绝」时同样在后台 isolate 内走 `ApiService.resolveApproval` 直接回报 server——**不依赖 App 主 isolate 是否存活**。
  - 注意后台 isolate 不共享主 isolate 的内存 / provider，需要各自构造最小依赖（baseUrl 等从持久化读取）。

- **iOS**：
  - 远程唤醒用 **APNs**，其中 Live Activity 的实时更新走 **APNs Live Activity push**（见第 3 节）；常规提醒走标准 APNs alert 推送。
  - App Intent 在 Live Activity 中执行时是短时后台运行，网络请求需容忍 App 被挂起：建议用后台 `URLSession`（background configuration）或经 App Group 落盘后由系统调度上报。
  - iOS 不存在 Android 那种"任意后台 isolate"，所有后台能力都受 APNs / BackgroundTasks / Live Activity push 约束。

### 现状与边界

- 当前**未接入 FCM / APNs**：审批通知只在 App 运行（前台或近期后台、WS 仍连着）时通过 WS + 本地通知触达。这对开发与"手机就在手边"的场景足够。
- 接入 FCM/APNs 属于后续工作，需要 server 侧推送服务 + 各平台证书 / 凭据，且 iOS 必须在 macOS/Xcode + 真机上验证（本机 Windows 无法完成）。
- 本 Agent 范围内只保证：Dart 侧编译通过、Android 内联动作 API 就绪、iOS 脚手架与文档完备且不破坏 web/analyze/Android 构建。
