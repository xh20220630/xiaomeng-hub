import 'package:flutter/foundation.dart' show debugPrint, kIsWeb;
import 'package:flutter/services.dart'
    show MethodChannel, PlatformException, MissingPluginException;

/// Dart-side bridge to the iOS ActivityKit Live Activity (Dynamic Island +
/// Lock Screen) that surfaces an in-flight approval / running task.
///
/// This is a **scaffold**: the native side (see
/// `app/ios/ClaudeActivityWidget/`) is a placeholder widget and the
/// `MethodChannel` handler is **not yet registered** in AppDelegate. Calls here
/// degrade gracefully — they are no-ops on web, Android, and any iOS build where
/// the native handler is absent (a `MissingPluginException` is caught and
/// logged). Wiring is intentionally deferred because it cannot be built or
/// verified on Windows (no Xcode / Apple toolchain).
///
/// TODO(ios): register a `MethodCallHandler` for [_channelName] in
/// `AppDelegate.swift`, bridge to `ClaudeActivityController` (ActivityKit), and
/// declare `NSSupportsLiveActivities = YES` in `Runner/Info.plist`.
class LiveActivityChannel {
  LiveActivityChannel._();
  static final LiveActivityChannel instance = LiveActivityChannel._();

  static const String _channelName = 'app.claude.monitor/live_activity';
  static const MethodChannel _channel = MethodChannel(_channelName);

  /// Whether the platform can host a Live Activity. Today this is only ever true
  /// on iOS 16.1+, but since the native handler is still a stub we keep it
  /// conservative and return false off-iOS so callers skip the round-trip.
  bool get _maybeSupported {
    if (kIsWeb) return false;
    // We avoid importing dart:io here to keep this file web-safe; the native
    // side is the real gatekeeper. defaultTargetPlatform could be used once the
    // handler exists. For the scaffold we attempt the call and swallow misses.
    return true;
  }

  /// Start a Live Activity for [sessionId].
  ///
  /// [title] is the project / task name; [status] is a short Chinese status line
  /// (e.g. 「运行中」「等待审批」); when [approvalId] is non-null the activity shows
  /// inline 批准 / 拒绝 App Intents.
  ///
  /// Returns the native activity id (opaque token used by [update]/[end]), or
  /// null if no activity was started.
  ///
  /// TODO(ios): map to `Activity<ClaudeActivityAttributes>.request(...)`.
  Future<String?> start({
    required String sessionId,
    required String title,
    required String status,
    String? approvalId,
  }) async {
    if (!_maybeSupported) return null;
    try {
      return await _channel.invokeMethod<String>('start', <String, dynamic>{
        'sessionId': sessionId,
        'title': title,
        'status': status,
        'approvalId': approvalId,
      });
    } on MissingPluginException {
      // Native handler not registered yet (expected for the current scaffold).
      debugPrint('[live_activity] start: native handler not registered (scaffold)');
      return null;
    } on PlatformException catch (e) {
      debugPrint('[live_activity] start failed: ${e.code} ${e.message}');
      return null;
    }
  }

  /// Update a running Live Activity's content state.
  ///
  /// TODO(ios): map to `activity.update(using: ...)`.
  Future<void> update({
    required String activityId,
    required String status,
    String? approvalId,
  }) async {
    if (!_maybeSupported) return;
    try {
      await _channel.invokeMethod<void>('update', <String, dynamic>{
        'activityId': activityId,
        'status': status,
        'approvalId': approvalId,
      });
    } on MissingPluginException {
      debugPrint('[live_activity] update: native handler not registered (scaffold)');
    } on PlatformException catch (e) {
      debugPrint('[live_activity] update failed: ${e.code} ${e.message}');
    }
  }

  /// End a Live Activity (task done / approval resolved). [finalStatus] is the
  /// dismissal text shown briefly on the Lock Screen (e.g. 「已完成」).
  ///
  /// TODO(ios): map to `activity.end(using: ..., dismissalPolicy: ...)`.
  Future<void> end({
    required String activityId,
    String finalStatus = '已完成',
  }) async {
    if (!_maybeSupported) return;
    try {
      await _channel.invokeMethod<void>('end', <String, dynamic>{
        'activityId': activityId,
        'finalStatus': finalStatus,
      });
    } on MissingPluginException {
      debugPrint('[live_activity] end: native handler not registered (scaffold)');
    } on PlatformException catch (e) {
      debugPrint('[live_activity] end failed: ${e.code} ${e.message}');
    }
  }
}
