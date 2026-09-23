import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'notification_service.dart';

/// Native build. Full local notifications on the real targets (Android / iOS /
/// macOS). On Windows/Linux desktop (used only for dev verification) we skip the
/// OS notification and just log, to avoid platform-specific setup — the app and
/// its live dashboard still work everywhere.
class NotificationServiceImpl implements NotificationService {
  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  bool _inited = false;

  bool get _supported => Platform.isAndroid || Platform.isIOS || Platform.isMacOS;

  @override
  Future<void> init() async {
    if (_inited || !_supported) return;
    // Status-bar small icon must be a white-alpha silhouette (ic_stat_meng),
    // not the coloured launcher icon — OEMs render the latter as a grey blob.
    const android = AndroidInitializationSettings('@drawable/ic_stat_meng');
    const darwin = DarwinInitializationSettings();
    const settings = InitializationSettings(
      android: android,
      iOS: darwin,
      macOS: darwin,
    );
    await _plugin.initialize(settings: settings);

    if (Platform.isIOS || Platform.isMacOS) {
      await _plugin
          .resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()
          ?.requestPermissions(alert: true, badge: true, sound: true);
    }
    if (Platform.isAndroid) {
      await _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission();
    }
    _inited = true;
  }

  @override
  Future<void> show(String title, String body, {String? payload}) async {
    if (!_supported) {
      debugPrint('[notify:skip-desktop] $title — $body');
      return;
    }
    await init();
    const details = NotificationDetails(
      android: AndroidNotificationDetails(
        'claude_tasks',
        'Agent 任务',
        channelDescription: 'Agent 任务进度与审批通知',
        importance: Importance.high,
        priority: Priority.high,
      ),
      iOS: DarwinNotificationDetails(),
      macOS: DarwinNotificationDetails(),
    );
    final id = DateTime.now().millisecondsSinceEpoch.remainder(100000);
    await _plugin.show(
      id: id,
      title: title,
      body: body,
      notificationDetails: details,
      payload: payload,
    );
  }

  /// Notification channel id used for approval requests. Kept separate from the
  /// general 'claude_tasks' channel so the user can tune its importance/sound
  /// independently and so the persistent + action behaviour is scoped to it.
  static const String _approvalChannelId = 'claude_approvals';

  /// Stable string prefixes embedded in each action's payload so a tap handler
  /// can decode `<verb>:<approvalId>` and call respondApproval(...).
  static const String approveActionPrefix = 'approve:';
  static const String rejectActionPrefix = 'reject:';

  @override
  Future<void> showApproval({
    required String approvalId,
    required String title,
    required String body,
  }) async {
    if (!_supported) {
      debugPrint('[notify:skip-desktop] approval $approvalId — $title');
      return;
    }
    await init();

    // Android: persistent, high-importance notification with inline 批准/拒绝
    // actions. Each action carries `<verb>:<approvalId>` so the action handler
    // (wired in main.dart via onDidReceiveNotificationResponse) can route it to
    // MonitorNotifier.respondApproval. `showsUserInterface: false` keeps the tap
    // from launching the full UI for the inline decision.
    final android = AndroidNotificationDetails(
      _approvalChannelId,
      'Agent 审批请求',
      channelDescription: 'Agent 需要你批准的操作',
      importance: Importance.max,
      priority: Priority.high,
      category: AndroidNotificationCategory.call,
      ongoing: true, // keep it resident until the user decides
      autoCancel: false,
      actions: <AndroidNotificationAction>[
        AndroidNotificationAction(
          'approve',
          '批准',
          showsUserInterface: false,
          cancelNotification: true,
        ),
        AndroidNotificationAction(
          'reject',
          '拒绝',
          showsUserInterface: false,
          cancelNotification: true,
        ),
      ],
    );

    // iOS: the rich, actionable surface is the Live Activity (see
    // live_activity/ + ios/ClaudeActivityWidget). Here we still post a plain
    // high-priority alert as a fallback / lock-screen ping.
    const darwin = DarwinNotificationDetails(
      presentAlert: true,
      presentBadge: true,
      presentSound: true,
      interruptionLevel: InterruptionLevel.timeSensitive,
    );

    final details = NotificationDetails(
      android: android,
      iOS: darwin,
      macOS: darwin,
    );

    // Use a stable id derived from the approvalId so a later resolve/cancel can
    // target the same notification.
    final id = approvalId.hashCode & 0x7fffffff;
    await _plugin.show(
      id: id,
      title: title,
      body: body,
      notificationDetails: details,
      // Plain payload routes a body-tap (open app); the action's actionId
      // ('approve'/'reject') is what distinguishes inline button taps.
      payload: '$approveActionPrefix$approvalId',
    );
  }
}
