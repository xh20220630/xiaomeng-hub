import 'package:flutter/foundation.dart'
    show kIsWeb, defaultTargetPlatform, TargetPlatform;
import 'package:flutter/services.dart';

/// Thin bridge to the native Android side over MethodChannel
/// 'claude/liveupdate' (cross-end contract):
///
/// dart -> native:
///   canPromote() -> bool
///   openPromotedSettings() -> bool
///   show({title,text,shortText,status,progressDone,progressTotal}) -> bool
///   hide()
///   configureService({baseUrl,wsUrl,token}) -> bool   (starts/restarts the
///     foreground service and persists config to native SharedPreferences)
///   stopService()
///   getLaunchDeeplink() -> {projectId?,sessionId?,approvalId?} | null
///
/// native -> dart:
///   onDeeplink {projectId?,sessionId?,approvalId?}
///
/// Every call is a no-op / safe-default on non-Android platforms so callers
/// never need to guard.
class LiveUpdate {
  static const _ch = MethodChannel('claude/liveupdate');

  static bool get _isAndroid =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  /// Whether the device+app can actually render the promoted capsule
  /// (Android 16 + the user hasn't disabled Live Updates for the app).
  static Future<bool> canPromote() async {
    if (!_isAndroid) return false;
    try {
      return await _ch.invokeMethod<bool>('canPromote') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Jump to the system settings page where the user can enable promoted
  /// (Live Update) notifications for this app. Returns false if the native
  /// side couldn't open it.
  static Future<bool> openPromotedSettings() async {
    if (!_isAndroid) return false;
    try {
      return await _ch.invokeMethod<bool>('openPromotedSettings') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Post or refresh the capsule. [shortText] is the tiny label shown in the
  /// collapsed chip (e.g. "运行中"); [text] shows when expanded. [status] and
  /// the optional progress pair let the native side pick icon/progress style.
  static Future<bool> show({
    required String title,
    required String text,
    String? shortText,
    String? status,
    int? progressDone,
    int? progressTotal,
    bool ongoing = true,
  }) async {
    if (!_isAndroid) return false;
    try {
      return await _ch.invokeMethod<bool>('show', {
            'title': title,
            'text': text,
            'shortText': shortText,
            'status': status,
            'progressDone': progressDone,
            'progressTotal': progressTotal,
            'ongoing': ongoing,
          }) ??
          false;
    } catch (_) {
      // Native side unavailable / older Android — ignore.
      return false;
    }
  }

  /// Dismiss the capsule (nothing is currently active).
  static Future<void> hide() async {
    if (!_isAndroid) return;
    try {
      await _ch.invokeMethod('hide');
    } catch (_) {}
  }

  /// Hand the current server endpoints + token to the native foreground
  /// service (it owns Android notifications) and persist them natively so the
  /// service can run app-less. Call at startup and whenever settings change.
  static Future<bool> configureService({
    required String baseUrl,
    required String wsUrl,
    String token = '',
  }) async {
    if (!_isAndroid) return false;
    try {
      return await _ch.invokeMethod<bool>('configureService', {
            'baseUrl': baseUrl,
            'wsUrl': wsUrl,
            'token': token,
          }) ??
          false;
    } catch (_) {
      return false;
    }
  }

  /// Stop the native foreground service.
  static Future<void> stopService() async {
    if (!_isAndroid) return;
    try {
      await _ch.invokeMethod('stopService');
    } catch (_) {}
  }

  /// The deeplink the app was launched with (notification tap through
  /// MainActivity extras), or null when launched normally.
  static Future<Map<String, String?>?> getLaunchDeeplink() async {
    if (!_isAndroid) return null;
    try {
      final raw = await _ch.invokeMethod<dynamic>('getLaunchDeeplink');
      if (raw is! Map) return null;
      return _castDeeplink(raw);
    } catch (_) {
      return null;
    }
  }

  /// Register the handler for native->dart 'onDeeplink' pushes (notification
  /// tapped while the app is alive). Only one handler is kept (last wins).
  static void setDeeplinkHandler(void Function(Map<String, String?> data) handler) {
    if (!_isAndroid) return;
    _ch.setMethodCallHandler((call) async {
      if (call.method == 'onDeeplink' && call.arguments is Map) {
        handler(_castDeeplink(call.arguments as Map));
      }
      return null;
    });
  }

  static Map<String, String?> _castDeeplink(Map raw) => {
        'projectId': raw['projectId'] as String?,
        'sessionId': raw['sessionId'] as String?,
        'approvalId': raw['approvalId'] as String?,
      };
}
