import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/painting.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import '../state/settings.dart';

final hostResourcesProvider = Provider<HostResourceService>((ref) {
  final settings = ref.watch(settingsProvider);
  final service = HostResourceService(settings.baseUrl, settings.token);
  ref.onDispose(service.dispose);
  return service;
});

class HostResource {
  final String id, name, kind, version, sourceName;
  final int size;
  final int? line;
  final bool snapshot, previewAvailable;
  const HostResource({
    required this.id,
    required this.name,
    required this.kind,
    required this.version,
    required this.size,
    this.line,
    this.sourceName = '宿主机',
    this.snapshot = false,
    this.previewAvailable = false,
  });
  factory HostResource.fromJson(Map<String, dynamic> data) => HostResource(
    id: data['resourceId'] as String,
    name: data['name'] as String,
    kind: data['kind'] as String,
    version: data['version'] as String,
    size: (data['size'] as num).toInt(),
    line: (data['line'] as num?)?.toInt(),
    sourceName: data['sourceName'] as String? ?? '宿主机',
    snapshot: data['snapshot'] == true,
    previewAvailable: data['previewAvailable'] == true,
  );
  String get sizeLabel => size < 1024
      ? '$size B'
      : size < 1024 * 1024
      ? '${(size / 1024).toStringAsFixed(1)} KB'
      : '${(size / 1024 / 1024).toStringAsFixed(1)} MB';
}

class HostResourceException implements Exception {
  final String code, message;
  const HostResourceException(this.code, this.message);
  @override
  String toString() => message;
}

class HostResourceService {
  final String baseUrl, token;
  final _clients = <http.Client>{};
  final _images = <String, Uint8List>{};
  int _cacheBytes = 0;
  bool _disposed = false;
  HostResourceService(this.baseUrl, this.token);

  Future<Uint8List> _request(
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
    required http.Client client,
    int maxBytes = 1024 * 1024,
  }) async {
    if (_disposed) throw const HostResourceException('CANCELLED', '主机连接已切换');
    if (token.isEmpty) {
      throw const HostResourceException('AUTH_REQUIRED', '请先扫码配对宿主机，再读取文件');
    }
    final uri = Uri.parse('$baseUrl/api$path').replace(queryParameters: query);
    final request = http.Request(body == null ? 'GET' : 'POST', uri)
      ..followRedirects = false
      ..headers['Authorization'] = 'Bearer $token';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    _clients.add(client);
    try {
      final response = await client
          .send(request)
          .timeout(const Duration(seconds: 35));
      if ((response.contentLength ?? 0) > maxBytes) {
        throw const HostResourceException('TOO_LARGE', '文件超过移动端预览限制');
      }
      final bytes = BytesBuilder(copy: false);
      await for (final part in response.stream.timeout(
        const Duration(seconds: 35),
      )) {
        if (bytes.length + part.length > maxBytes) {
          throw const HostResourceException('TOO_LARGE', '文件超过移动端预览限制');
        }
        bytes.add(part);
      }
      final result = bytes.takeBytes();
      if (response.statusCode != 200) {
        if (response.statusCode == 401) clearCache();
        Map<String, dynamic>? error;
        try {
          error = jsonDecode(utf8.decode(result)) as Map<String, dynamic>;
        } catch (_) {}
        throw HostResourceException(
          error?['code'] as String? ?? 'HTTP_ERROR',
          error?['error'] as String? ??
              (response.statusCode == 404
                  ? '宿主机暂不支持资源预览，或文件已不存在'
                  : '文件读取失败（${response.statusCode}）'),
        );
      }
      if (_disposed) throw const HostResourceException('CANCELLED', '主机连接已切换');
      return result;
    } on TimeoutException {
      throw const HostResourceException('HOST_TIMEOUT', '宿主机响应超时，请检查连接后重试');
    } on http.ClientException {
      throw const HostResourceException('HOST_OFFLINE', '无法连接宿主机，请确认电脑服务在线');
    } finally {
      _clients.remove(client);
    }
  }

  Future<HostResource> resolve(
    String sessionId,
    String reference, {
    String? baseResourceId,
    required http.Client client,
  }) async {
    final bytes = await _request(
      '/sessions/${Uri.encodeComponent(sessionId)}/resources/resolve',
      body: {'reference': reference, 'baseResourceId': ?baseResourceId},
      client: client,
    );
    return HostResource.fromJson(
      jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>,
    );
  }

  Future<Map<String, dynamic>> text(
    HostResource resource, {
    int startLine = 1,
    required http.Client client,
  }) async =>
      jsonDecode(
            utf8.decode(
              await _request(
                '/resources/${Uri.encodeComponent(resource.id)}/text',
                query: {'version': resource.version, 'startLine': '$startLine'},
                client: client,
              ),
            ),
          )
          as Map<String, dynamic>;

  Future<Map<String, dynamic>> list(
    HostResource resource, {
    String? cursor,
    required http.Client client,
  }) async =>
      jsonDecode(
            utf8.decode(
              await _request(
                '/resources/${Uri.encodeComponent(resource.id)}/entries',
                query: {'cursor': ?cursor},
                client: client,
              ),
            ),
          )
          as Map<String, dynamic>;

  Future<Uint8List> image(
    HostResource resource, {
    bool thumbnail = true,
    required http.Client client,
  }) async {
    if (_disposed) throw const HostResourceException('CANCELLED', '主机连接已切换');
    final key = '${resource.id}:${resource.version}:$thumbnail';
    final cached = _images.remove(key);
    if (cached != null) {
      _images[key] = cached;
      return cached;
    }
    final bytes = await _request(
      '/resources/${Uri.encodeComponent(resource.id)}/${thumbnail ? 'thumbnail' : 'content'}',
      query: {'version': resource.version},
      client: client,
      maxBytes: 20 * 1024 * 1024,
    );
    _images[key] = bytes;
    _cacheBytes += bytes.length;
    while (_cacheBytes > 32 * 1024 * 1024 && _images.isNotEmpty) {
      final removed = _images.remove(_images.keys.first)!;
      _cacheBytes -= removed.length;
      MemoryImage(removed).evict();
    }
    return bytes;
  }

  void clearCache() {
    for (final bytes in _images.values) {
      MemoryImage(bytes).evict();
    }
    _images.clear();
    _cacheBytes = 0;
  }

  void dispose() {
    _disposed = true;
    for (final client in _clients.toList()) {
      client.close();
    }
    _clients.clear();
    clearCache();
  }
}
