import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

const updateRepository = 'xh20220630/xiaomeng-hub';

class AppVersion implements Comparable<AppVersion> {
  final String name;
  final int build;

  const AppVersion(this.name, this.build);

  static final pattern = RegExp(
    r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$',
  );

  @override
  int compareTo(AppVersion other) {
    final a = pattern.firstMatch(name);
    final b = pattern.firstMatch(other.name);
    if (a == null || b == null) throw const FormatException('版本号格式不正确');
    for (var i = 1; i <= 3; i++) {
      final result = int.parse(a[i]!).compareTo(int.parse(b[i]!));
      if (result != 0) return result;
    }
    final ap = a[4]?.split('.');
    final bp = b[4]?.split('.');
    if (ap == null && bp != null) return 1;
    if (ap != null && bp == null) return -1;
    if (ap != null && bp != null) {
      for (var i = 0; i < ap.length && i < bp.length; i++) {
        final an = int.tryParse(ap[i]);
        final bn = int.tryParse(bp[i]);
        final result = an != null && bn != null
            ? an.compareTo(bn)
            : an != null
            ? -1
            : bn != null
            ? 1
            : ap[i].compareTo(bp[i]);
        if (result != 0) return result;
      }
      final result = ap.length.compareTo(bp.length);
      if (result != 0) return result;
    }
    return build.compareTo(other.build);
  }

  bool isNewerThan(AppVersion installed) =>
      build > installed.build && compareTo(installed) > 0;

  String get label => '$name（build $build）';
}

class AppRelease {
  final AppVersion version;
  final String url;
  final String sha256;
  final int bytes;
  final String notes;
  final bool preview;

  const AppRelease({
    required this.version,
    required this.url,
    required this.sha256,
    required this.bytes,
    required this.notes,
    required this.preview,
  });

  Map<String, dynamic> toJson() => {
    'version': version.name,
    'build': version.build,
    'url': url,
    'sha256': sha256,
    'bytes': bytes,
    'notes': notes,
    'preview': preview,
  };

  factory AppRelease.fromJson(Map<String, dynamic> json) => AppRelease(
    version: AppVersion(json['version'] as String, json['build'] as int),
    url: json['url'] as String,
    sha256: json['sha256'] as String,
    bytes: json['bytes'] as int,
    notes: json['notes'] as String,
    preview: json['preview'] as bool,
  );

  String get sizeLabel => '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}

bool isReleaseAssetUrl(String value) {
  final uri = Uri.tryParse(value);
  return uri != null &&
      uri.scheme == 'https' &&
      uri.host == 'github.com' &&
      uri.userInfo.isEmpty &&
      uri.port == 443 &&
      uri.path.startsWith('/$updateRepository/releases/download/');
}

class ReleaseClient {
  final http.Client client;

  ReleaseClient(this.client);

  Future<dynamic> _json(String url) async {
    final response = await client
        .get(Uri.parse(url), headers: {'Accept': 'application/vnd.github+json'})
        .timeout(const Duration(seconds: 25));
    if (response.statusCode == 403 || response.statusCode == 429) {
      throw const UpdateException('GitHub 请求暂时受限，请稍后重试');
    }
    if (response.statusCode != 200) {
      throw UpdateException('更新服务器返回 ${response.statusCode}，请稍后重试');
    }
    return jsonDecode(utf8.decode(response.bodyBytes));
  }

  Future<AppRelease?> latest(AppVersion installed, bool previews) async {
    // /latest omits prereleases; list releases so the test channel can update too.
    final releases =
        await _json(
              'https://api.github.com/repos/$updateRepository/releases?per_page=100',
            )
            as List;
    AppRelease? latest;
    for (final value in releases) {
      final release = value as Map<String, dynamic>;
      if (release['draft'] == true ||
          (!previews && release['prerelease'] == true)) {
        continue;
      }
      final assets = (release['assets'] as List).cast<Map<String, dynamic>>();
      for (final apk in assets) {
        final match = RegExp(
          r'^xiaomeng-v(.+?)(?:-build(\d+))?-android\.apk$',
        ).firstMatch(apk['name'] as String);
        if (match == null || !AppVersion.pattern.hasMatch(match[1]!)) continue;
        if (AppVersion(match[1]!, 2100000000).compareTo(installed) < 0) {
          continue;
        }
        final url = apk['browser_download_url'] as String;
        if (!isReleaseAssetUrl(url)) continue;
        int? build = int.tryParse(match[2] ?? '');
        var digest = (apk['digest'] as String? ?? '').replaceFirst(
          'sha256:',
          '',
        );
        if (build == null) {
          final manifests = assets.where(
            (a) => a['name'] == 'release-manifest.json',
          );
          if (manifests.isEmpty) continue;
          final manifestUrl = manifests.first['browser_download_url'] as String;
          if (!isReleaseAssetUrl(manifestUrl)) continue;
          final manifest = await _json(manifestUrl) as Map<String, dynamic>;
          if (manifest['version'] != match[1]) continue;
          build = manifest['buildNumber'] as int?;
          final entries = (manifest['artifacts'] as List)
              .cast<Map<String, dynamic>>()
              .where(
                (a) => a['name'] == apk['name'] && a['bytes'] == apk['size'],
              );
          if (entries.isEmpty) continue;
          final hash = entries.first['sha256'] as String;
          if (digest.isNotEmpty && digest != hash) {
            throw const UpdateException('发布文件校验信息不一致');
          }
          digest = hash;
        }
        if (build == null || build <= 0) continue;
        final version = AppVersion(match[1]!, build);
        if (!version.isNewerThan(installed)) continue;
        if (!RegExp(r'^[a-fA-F0-9]{64}$').hasMatch(digest)) {
          throw const UpdateException('新版缺少 SHA-256 校验信息，暂时无法安全更新');
        }
        final bytes = apk['size'] as int;
        if (bytes <= 0 || bytes > 512 * 1024 * 1024) continue;
        final candidate = AppRelease(
          version: version,
          url: url,
          sha256: digest.toLowerCase(),
          bytes: bytes,
          notes: release['body'] as String? ?? '此版本未提供更新说明。',
          preview: release['prerelease'] == true,
        );
        if (latest == null || version.compareTo(latest.version) > 0) {
          latest = candidate;
        }
      }
    }
    return latest;
  }
}

class UpdateException implements Exception {
  final String message;
  const UpdateException(this.message);
  @override
  String toString() => message;
}

class UpdatePlatform {
  static const channel = MethodChannel('xiaomeng/app_updates');

  bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  Future<Map<String, dynamic>> info() async =>
      Map<String, dynamic>.from(await channel.invokeMethod('info') as Map);

  void onProgress(void Function(double) listener) {
    channel.setMethodCallHandler((call) async {
      if (call.method == 'progress') {
        listener((call.arguments as num).toDouble());
      }
    });
  }

  Future<void> download(AppRelease release, {required bool wifiOnly}) async {
    await channel.invokeMethod('download', {
      ...release.toJson(),
      'wifiOnly': wifiOnly,
    });
  }

  Future<void> cancel() => channel.invokeMethod('cancel');
  Future<bool> install() async =>
      await channel.invokeMethod<bool>('install') ?? false;
  Future<void> clear() => channel.invokeMethod('clear');
  void dispose() => channel.setMethodCallHandler(null);
}
