import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../services/app_updates.dart';
import 'settings.dart';

final appUpdatesProvider = Provider<AppUpdates>((ref) {
  final client = http.Client();
  final updates = AppUpdates(
    ref.watch(sharedPrefsProvider),
    ReleaseClient(client),
    UpdatePlatform(),
  );
  ref.onDispose(() {
    updates.dispose();
    client.close();
  });
  return updates;
});

class AppUpdates extends ChangeNotifier {
  final SharedPreferences prefs;
  final ReleaseClient releases;
  final UpdatePlatform platform;
  AppVersion? installed;
  AppRelease? available;
  bool checking = false;
  bool downloading = false;
  bool installing = false;
  bool ready = false;
  bool waitingForPermission = false;
  bool _disposed = false;
  bool _foreground = true;
  bool _initializing = false;
  bool debugSigned = false;
  double progress = 0;
  String? message;
  DateTime? _lastAttempt;
  DateTime? _nextDownloadAttempt;

  AppUpdates(this.prefs, this.releases, this.platform) {
    platform.onProgress((value) {
      progress = value.clamp(0, 1);
      _notify();
    });
  }

  bool get supported => platform.supported;
  bool get busy => checking || downloading || installing || _initializing;
  bool get autoCheck => prefs.getBool('updates.autoCheck') ?? true;
  bool get autoDownload => prefs.getBool('updates.autoDownload') ?? true;
  bool get previews => prefs.getBool('updates.previews') ?? debugSigned;
  DateTime? get lastChecked {
    final stamp = prefs.getInt('updates.lastChecked');
    return stamp == null ? null : DateTime.fromMillisecondsSinceEpoch(stamp);
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> initialize() async {
    if (!supported || installed != null || _initializing) return;
    _initializing = true;
    try {
      final info = await platform.info();
      installed = AppVersion(info['version'] as String, info['build'] as int);
      debugSigned = info['debugSigned'] == true;
      final cached = info['ready'] as String?;
      if (cached != null) {
        final release = AppRelease.fromJson(
          jsonDecode(cached) as Map<String, dynamic>,
        );
        if (release.version.isNewerThan(installed!) &&
            (!release.preview || previews)) {
          available = release;
          ready = true;
        }
      }
    } catch (_) {
      message = '无法读取应用版本，请重试';
    } finally {
      _initializing = false;
      _notify();
    }
  }

  Future<void> setOption(String key, bool enabled) async {
    await prefs.setBool('updates.$key', enabled);
    if (key == 'previews') {
      _nextDownloadAttempt = null;
      available = null;
      ready = false;
      await platform.clear();
    }
    _notify();
    if (key == 'previews') await check();
    if (key == 'autoCheck' && enabled) await checkAutomatic();
    if (key == 'autoDownload' && enabled) await _downloadAutomatically();
  }

  Future<void> foreground(bool active) async {
    _foreground = active;
    if (!active) return;
    if (waitingForPermission) {
      waitingForPermission = false;
      try {
        final info = await platform.info();
        if (info['canInstall'] == true) {
          await install();
        } else {
          message = '尚未允许安装更新，可点击“安装更新”重新授权';
        }
      } catch (_) {
        message = '无法读取安装权限，请点击“安装更新”重试';
      } finally {
        _notify();
      }
    }
    await checkAutomatic();
  }

  Future<void> checkAutomatic() async {
    await initialize();
    if (!autoCheck || !_foreground || busy || installed == null) return;
    final last = _lastAttempt ?? lastChecked;
    if (last == null ||
        DateTime.now().difference(last) >= const Duration(hours: 6)) {
      await check();
    } else {
      await _downloadAutomatically();
    }
  }

  Future<void> check() async {
    if (busy || !supported) return;
    await initialize();
    if (installed == null || _disposed || busy) return;
    checking = true;
    message = null;
    _lastAttempt = DateTime.now();
    _notify();
    try {
      final next = await releases.latest(installed!, previews);
      if (_disposed) return;
      if (available?.sha256 != next?.sha256) {
        _nextDownloadAttempt = null;
        await platform.clear();
        ready = false;
      }
      available = next;
      await prefs.setInt(
        'updates.lastChecked',
        DateTime.now().millisecondsSinceEpoch,
      );
      message = next == null
          ? '当前渠道暂无可用更新'
          : ready
          ? '更新已准备好，可以安装'
          : '发现新版本 ${next.version.name}';
    } catch (error) {
      message = _error(error, '检查更新失败，请检查网络后重试');
    } finally {
      checking = false;
      _notify();
    }
    await _downloadAutomatically();
  }

  Future<void> _downloadAutomatically() async {
    if (_disposed) return;
    if (_nextDownloadAttempt != null &&
        DateTime.now().isBefore(_nextDownloadAttempt!)) {
      return;
    }
    if (autoDownload && _foreground && available != null && !ready && !busy) {
      await download(wifiOnly: true);
    }
  }

  Future<void> download({bool wifiOnly = false}) async {
    final release = available;
    if (release == null || busy || ready) return;
    downloading = true;
    progress = 0;
    message = null;
    _notify();
    try {
      await platform.download(release, wifiOnly: wifiOnly);
      ready = true;
      message = '下载及校验完成，点击“安装更新”继续';
    } catch (error) {
      if (_nextDownloadAttempt == null ||
          DateTime.now().isAfter(_nextDownloadAttempt!)) {
        _nextDownloadAttempt = DateTime.now().add(const Duration(minutes: 30));
      }
      message = _error(error, '下载失败，请稍后重试');
    } finally {
      downloading = false;
      _notify();
    }
  }

  Future<void> cancel() async {
    await platform.cancel();
    _nextDownloadAttempt = DateTime.now().add(const Duration(hours: 6));
  }

  Future<void> install() async {
    if (!ready || busy) return;
    installing = true;
    _notify();
    try {
      final launched = await platform.install();
      waitingForPermission = !launched;
      message = launched ? '请在 Android 安装界面确认；取消后可再次安装' : '请允许此应用安装更新，返回后将继续安装';
    } catch (error) {
      message = _error(error, '无法启动安装，请重新下载后重试');
      ready = false;
    } finally {
      installing = false;
      _notify();
    }
  }

  String _error(Object error, String fallback) {
    if (error is UpdateException) return error.message;
    if (error is PlatformException) return error.message ?? fallback;
    if (error is TimeoutException) return '连接更新服务器超时，请稍后重试';
    return fallback;
  }

  @override
  void dispose() {
    _disposed = true;
    platform.dispose();
    super.dispose();
  }
}
