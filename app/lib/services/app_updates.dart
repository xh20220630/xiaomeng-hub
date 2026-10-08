import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:html2md/html2md.dart' as html2md;
import 'package:xml/xml.dart';

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

class ReleaseHistoryEntry {
  final String id;
  final String version;
  final int? build;
  final String title;
  final String notes;
  final bool? preview;
  final DateTime? publishedAt;
  final String? url;

  const ReleaseHistoryEntry({
    required this.id,
    required this.version,
    this.build,
    required this.title,
    required this.notes,
    required this.preview,
    this.publishedAt,
    this.url,
  });

  bool matchesInstalled(AppVersion? installed) =>
      installed != null &&
      version == installed.name &&
      (build == null || build == installed.build);

  String get channelLabel => switch (preview) {
    true => '测试版',
    false => '正式版',
    null => '渠道待确认',
  };

  String get dateLabel {
    final date = publishedAt?.toLocal();
    if (date == null) return '发布日期未提供';
    return '${date.year}.${date.month.toString().padLeft(2, '0')}.${date.day.toString().padLeft(2, '0')}';
  }

  String get summary {
    final lines = notes
        .split('\n')
        .map((line) => line.trim())
        .where(
          (line) =>
              line.isNotEmpty &&
              !line.startsWith('#') &&
              !line.startsWith('```'),
        );
    if (lines.isEmpty) return '此版本未提供更新说明。';
    return lines.first
        .replaceAllMapped(
          RegExp(r'\[([^\]]+)\]\([^)]*\)'),
          (match) => match[1]!,
        )
        .replaceAll(RegExp(r'[*_`]'), '')
        .replaceFirst(RegExp(r'^[-+>]\s+'), '');
  }

  static ReleaseHistoryEntry? fromGithub(Map<String, dynamic> data) {
    if (data['draft'] == true) return null;
    final tag = data['tag_name'] as String? ?? '';
    String? version;
    int? build;
    for (final asset in data['assets'] as List? ?? const []) {
      if (asset is! Map || asset['name'] is! String) continue;
      final match = RegExp(
        r'^xiaomeng-v(.+?)(?:-build(\d+))?-android\.apk$',
      ).firstMatch(asset['name'] as String);
      if (match != null && AppVersion.pattern.hasMatch(match[1]!)) {
        version = match[1];
        build = int.tryParse(match[2] ?? '');
        break;
      }
    }
    final tagged = RegExp(
      r'^(?:v|(?:android-)?preview-)?(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)(?:-build(\d+))?$',
    ).firstMatch(tag);
    version ??= tagged?[1];
    build ??= int.tryParse(tagged?[2] ?? '');
    version ??= tag;
    if (version.isEmpty) return null;
    final rawUrl = data['html_url'] as String?;
    final uri = rawUrl == null ? null : Uri.tryParse(rawUrl);
    final validUrl =
        uri != null &&
        uri.scheme == 'https' &&
        uri.host == 'github.com' &&
        uri.userInfo.isEmpty &&
        uri.port == 443 &&
        uri.path.startsWith('/$updateRepository/releases/tag/');
    final title = (data['name'] as String? ?? '').trim();
    return ReleaseHistoryEntry(
      id: data['id']?.toString() ?? (tag.isNotEmpty ? tag : '$version+$build'),
      version: version,
      build: build,
      title: title.isEmpty ? version : title,
      notes: data['body'] as String? ?? '',
      preview: data['prerelease'] == true,
      publishedAt: DateTime.tryParse(data['published_at'] as String? ?? ''),
      url: validUrl ? rawUrl : null,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'version': version,
    'build': build,
    'title': title,
    'notes': notes,
    'preview': preview,
    'publishedAt': publishedAt?.toIso8601String(),
    'url': url,
  };

  factory ReleaseHistoryEntry.fromJson(Map<String, dynamic> json) =>
      ReleaseHistoryEntry(
        id: json['id'] as String,
        version: json['version'] as String,
        build: json['build'] as int?,
        title: json['title'] as String,
        notes: json['notes'] as String,
        preview: json['preview'] as bool?,
        publishedAt: DateTime.tryParse(json['publishedAt'] as String? ?? ''),
        url: json['url'] as String?,
      );
}

class ReleaseHistoryPage {
  final List<ReleaseHistoryEntry> entries;
  final bool hasMore;
  final bool partial;
  final String? notice;
  const ReleaseHistoryPage(
    this.entries, {
    required this.hasMore,
    this.partial = false,
    this.notice,
  });
}

class ReleaseClient {
  final http.Client client;
  final DateTime Function() now;
  final Duration cacheDuration;
  final _cache = <String, ({DateTime expires, http.Response response})>{};
  final _pending = <String, Future<http.Response>>{};
  DateTime? _apiRetryAt;
  String? notice;

  ReleaseClient(
    this.client, {
    DateTime Function()? now,
    this.cacheDuration = const Duration(minutes: 1),
  }) : now = now ?? DateTime.now;

  Future<http.Response> _read(String url, {bool redirect = true}) async {
    final key = '$redirect:$url';
    final cached = _cache[key];
    if (cached != null && now().isBefore(cached.expires)) {
      return cached.response;
    }
    final pending = _pending[key];
    if (pending != null) return pending;
    final api = Uri.parse(url).host == 'api.github.com';
    if (api && _apiRetryAt != null && now().isBefore(_apiRetryAt!)) {
      throw _rateLimit(_apiRetryAt!);
    }
    final request = _fetch(url, api: api, redirect: redirect);
    _pending[key] = request;
    try {
      final response = await request;
      _cache[key] = (expires: now().add(cacheDuration), response: response);
      return response;
    } finally {
      _pending.remove(key);
    }
  }

  Future<http.Response> _fetch(
    String url, {
    required bool api,
    required bool redirect,
  }) async {
    final request = http.Request(redirect ? 'GET' : 'HEAD', Uri.parse(url))
      ..followRedirects = redirect
      ..headers['User-Agent'] = 'Xiaomeng-App-Updater'
      ..headers['Accept'] = api ? 'application/vnd.github+json' : '*/*';
    final response = await client
        .send(request)
        .then(http.Response.fromStream)
        .timeout(const Duration(seconds: 25));
    final rateLimited =
        response.statusCode == 429 ||
        (response.statusCode == 403 &&
            (response.headers['x-ratelimit-remaining'] == '0' ||
                response.headers.containsKey('retry-after') ||
                response.body.toLowerCase().contains('rate limit')));
    if (rateLimited) {
      final seconds = int.tryParse(response.headers['retry-after'] ?? '');
      final reset = int.tryParse(response.headers['x-ratelimit-reset'] ?? '');
      var retryAt = now().add(const Duration(minutes: 1));
      if (seconds != null && seconds > 0) {
        retryAt = now().add(Duration(seconds: seconds));
      }
      if (response.headers['x-ratelimit-remaining'] == '0' &&
          reset != null &&
          reset > 0 &&
          reset < 8640000000000) {
        final limitReset = DateTime.fromMillisecondsSinceEpoch(reset * 1000);
        if (limitReset.isAfter(retryAt)) retryAt = limitReset;
      }
      if (api) _apiRetryAt = retryAt;
      throw _rateLimit(retryAt, api: api);
    }
    if (response.statusCode == 403) {
      throw const _UpdateSourceException('GitHub 拒绝访问更新源（403），请切换网络后重试');
    }
    if (response.statusCode != 200 &&
        !(redirect == false &&
            [301, 302, 307, 308].contains(response.statusCode))) {
      throw _UpdateSourceException(
        '更新源返回 ${response.statusCode}，请稍后重试',
        status: response.statusCode,
      );
    }
    return response;
  }

  _UpdateSourceException _rateLimit(DateTime retryAt, {bool api = true}) {
    final time = retryAt.toLocal();
    final label =
        '${time.hour.toString().padLeft(2, '0')}:'
        '${time.minute.toString().padLeft(2, '0')}:'
        '${time.second.toString().padLeft(2, '0')}';
    return _UpdateSourceException(
      '${api ? 'GitHub API 请求额度已用完' : 'GitHub 发布站点请求受限'}，预计 $label 后恢复；可切换网络重试',
    );
  }

  Future<dynamic> _json(String url) async {
    final response = await _read(url);
    return jsonDecode(utf8.decode(response.bodyBytes));
  }

  Future<ReleaseHistoryPage> history({int page = 1}) async {
    try {
      return await _historyFromApi(page);
    } on _UpdateSourceException catch (error) {
      return _historyFromFeed(page, error);
    } on TimeoutException catch (error) {
      return _historyFromFeed(page, error);
    } on http.ClientException catch (error) {
      return _historyFromFeed(page, error);
    } on FormatException catch (error) {
      return _historyFromFeed(page, error);
    }
  }

  Future<ReleaseHistoryPage> _historyFromApi(int page) async {
    final data = await _json(
      'https://api.github.com/repos/$updateRepository/releases?per_page=20&page=$page',
    );
    if (data is! List) throw const FormatException('Invalid release history');
    final entries = <ReleaseHistoryEntry>[];
    // Reading release notes must not require a downloadable or signed APK.
    for (final value in data) {
      if (value is! Map<String, dynamic>) continue;
      try {
        final entry = ReleaseHistoryEntry.fromGithub(value);
        if (entry != null) entries.add(entry);
      } on FormatException {
        continue;
      } on TypeError {
        continue;
      }
    }
    return ReleaseHistoryPage(entries, hasMore: data.length >= 20);
  }

  Future<ReleaseHistoryPage> _historyFromFeed(int page, Object apiError) async {
    if (page > 1) {
      throw UpdateException('暂时无法加载更早版本：${_sourceError(apiError)}；已加载的说明仍可阅读');
    }
    try {
      final entries = await _releaseFeed();
      return ReleaseHistoryPage(
        entries.values.toList(),
        hasMore: false,
        partial: true,
        notice: '已通过官方发布订阅加载近期更新说明；完整历史与渠道信息可在 GitHub 发布页查看',
      );
    } catch (error) {
      throw _bothSourcesFailed('加载版本历史', apiError, error);
    }
  }

  Future<AppRelease?> latest(AppVersion installed, bool previews) async {
    notice = null;
    try {
      return await _latestFromApi(installed, previews);
    } on _UpdateSourceException catch (error) {
      return _latestFromFeed(installed, previews, error);
    } on TimeoutException catch (error) {
      return _latestFromFeed(installed, previews, error);
    } on http.ClientException catch (error) {
      return _latestFromFeed(installed, previews, error);
    } on FormatException catch (error) {
      return _latestFromFeed(installed, previews, error);
    }
  }

  Future<AppRelease?> _latestFromApi(
    AppVersion installed,
    bool previews,
  ) async {
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

  Future<Map<String, ReleaseHistoryEntry>> _releaseFeed() async {
    final response = await _read(
      'https://github.com/$updateRepository/releases.atom',
    );
    final document = XmlDocument.parse(utf8.decode(response.bodyBytes));
    if (document.rootElement.name.local != 'feed') {
      throw const FormatException('Invalid release feed');
    }
    final records = <String, ReleaseHistoryEntry>{};
    for (final entry in document.rootElement.findElements('entry')) {
      final link = entry
          .findElements('link')
          .where((link) => link.getAttribute('rel') == 'alternate')
          .firstOrNull;
      final url = link?.getAttribute('href');
      final tag = _releaseTag(url);
      if (tag == null) continue;
      final parsed = ReleaseHistoryEntry.fromGithub({'tag_name': tag});
      if (parsed == null) continue;
      records[tag] = ReleaseHistoryEntry(
        id: tag,
        version: parsed.version,
        build: parsed.build,
        title: entry.getElement('title')?.innerText ?? parsed.version,
        notes: html2md.convert(
          entry.getElement('content')?.innerText ?? '',
          styleOptions: {'headingStyle': 'atx', 'codeBlockStyle': 'fenced'},
          ignore: ['script', 'style'],
        ),
        // Atom 不提供 prerelease 标记，历史展示也不能根据标签名称推测渠道。
        preview: null,
        publishedAt: DateTime.tryParse(
          entry.getElement('published')?.innerText ??
              entry.getElement('updated')?.innerText ??
              '',
        ),
        url: url,
      );
    }
    if (records.isEmpty &&
        document.rootElement.findElements('entry').isNotEmpty) {
      throw const FormatException('No valid release entries');
    }
    return records;
  }

  Future<AppRelease?> _latestFromFeed(
    AppVersion installed,
    bool previews,
    Object apiError,
  ) async {
    try {
      final records = await _releaseFeed();
      final hadEntries = records.isNotEmpty;
      records.removeWhere(
        (_, entry) => !AppVersion.pattern.hasMatch(entry.version),
      );
      if (hadEntries && records.isEmpty) {
        throw const FormatException('No valid release versions');
      }
      // Atom omits prerelease flags. Only GitHub's /latest redirect can establish
      // a stable release; never infer the installation channel from its tag name.
      String? stableTag;
      if (!previews) {
        final stable = await _read(
          'https://github.com/$updateRepository/releases/latest',
          redirect: false,
        );
        stableTag = _releaseTag(stable.headers['location']);
        if (stableTag == null &&
            stable.headers['location'] !=
                'https://github.com/$updateRepository/releases') {
          throw const FormatException('Unknown stable release');
        }
      }
      if (stableTag != null && !records.containsKey(stableTag)) {
        final parsed = ReleaseHistoryEntry.fromGithub({'tag_name': stableTag});
        if (parsed == null || !AppVersion.pattern.hasMatch(parsed.version)) {
          throw const FormatException('Unknown release version');
        }
        records[stableTag] = ReleaseHistoryEntry(
          id: stableTag,
          version: parsed.version,
          build: parsed.build,
          title: parsed.title,
          preview: false,
          notes:
              '[查看官方更新说明](https://github.com/$updateRepository/releases/tag/$stableTag)',
        );
      }
      AppRelease? latest;
      final ordered = records.entries.toList()
        ..sort(
          (a, b) => AppVersion(
            b.value.version,
            b.value.build ?? 0,
          ).compareTo(AppVersion(a.value.version, a.value.build ?? 0)),
        );
      for (final entry in ordered) {
        if (!previews && entry.key != stableTag) continue;
        final record = entry.value;
        if (AppVersion(
              record.version,
              record.build ?? 2100000000,
            ).compareTo(installed) <=
            0) {
          continue;
        }
        if (latest != null) break;
        final base =
            'https://github.com/$updateRepository/releases/download/${Uri.encodeComponent(entry.key)}';
        // The feed discovers releases; the official manifest supplies the
        // package size and checksum. Missing metadata never permits an install.
        final manifest =
            await _json('$base/release-manifest.json') as Map<String, dynamic>;
        final build = manifest['buildNumber'] as int;
        if (manifest['version'] != record.version ||
            (record.build != null && record.build != build) ||
            build <= 0 ||
            build > 2100000000) {
          throw const UpdateException('备用更新源的版本校验信息不一致');
        }
        final version = AppVersion(record.version, build);
        if (!version.isNewerThan(installed)) continue;
        for (final asset
            in (manifest['artifacts'] as List).cast<Map<String, dynamic>>()) {
          final name = asset['name'] as String;
          if (name != 'xiaomeng-v${version.name}-android.apk' &&
              name != 'xiaomeng-v${version.name}-build$build-android.apk') {
            continue;
          }
          final hash = asset['sha256'] as String;
          final bytes = asset['bytes'] as int;
          if (!RegExp(r'^[a-fA-F0-9]{64}$').hasMatch(hash) ||
              bytes <= 0 ||
              bytes > 512 * 1024 * 1024) {
            throw const UpdateException('备用更新源缺少有效的安装包校验信息');
          }
          final candidate = AppRelease(
            version: version,
            url: '$base/$name',
            sha256: hash.toLowerCase(),
            bytes: bytes,
            notes: record.notes,
            preview: previews,
          );
          if (latest == null || version.compareTo(latest.version) > 0) {
            latest = candidate;
          }
        }
      }
      notice = '已通过官方发布订阅完成检查';
      return latest;
    } catch (error) {
      if (error is UpdateException && error is! _UpdateSourceException) rethrow;
      throw _bothSourcesFailed('检查更新', apiError, error);
    }
  }

  String _sourceError(Object error) => switch (error) {
    UpdateException() => error.message,
    TimeoutException() => '连接超时',
    http.ClientException() => '网络连接失败',
    _ => '返回数据格式异常',
  };

  UpdateException _bothSourcesFailed(
    String action,
    Object api,
    Object feed,
  ) => UpdateException(
    '$action未完成：${_sourceError(api)}；备用发布源也未能完成：${_sourceError(feed)}。可在官方下载页查看版本。',
  );

  String? _releaseTag(String? value) {
    final uri = value == null ? null : Uri.tryParse(value);
    final prefix = '/$updateRepository/releases/tag/';
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host != 'github.com' ||
        uri.userInfo.isNotEmpty ||
        uri.port != 443 ||
        !uri.path.startsWith(prefix) ||
        uri.hasQuery ||
        uri.hasFragment) {
      return null;
    }
    final tag = Uri.decodeComponent(uri.path.substring(prefix.length));
    return RegExp(r'^[0-9A-Za-z._-]+$').hasMatch(tag) ? tag : null;
  }
}

class _UpdateSourceException extends UpdateException {
  final int? status;
  const _UpdateSourceException(super.message, {this.status});
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
