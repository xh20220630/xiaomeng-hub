import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;
import '../state/settings.dart';

class PairingException implements Exception {
  final String message;
  final String? code;
  const PairingException(this.message, {this.code});
  @override
  String toString() => message;
}

class PairingLink {
  final Uri server;
  final String hostName;
  final String code;
  final DateTime expiresAt;

  const PairingLink({
    required this.server,
    required this.hostName,
    required this.code,
    required this.expiresAt,
  });

  factory PairingLink.parse(String raw, {DateTime? now}) {
    try {
      if (raw.length > 2048) throw const FormatException();
      final uri = Uri.parse(raw.trim());
      if (uri.scheme != 'xiaomeng' ||
          uri.host != 'pair' ||
          uri.path.isNotEmpty ||
          uri.hasFragment ||
          uri.userInfo.isNotEmpty ||
          uri.hasPort ||
          uri.queryParametersAll.values.any((values) => values.length != 1)) {
        throw const FormatException();
      }
      final values = uri.queryParameters;
      if (values['v'] != '1') throw const FormatException();
      final server = Uri.parse(values['server'] ?? '');
      final octets = server.host.split('.').map(int.tryParse).toList();
      if (server.scheme != 'http' ||
          !server.hasPort ||
          server.port < 1 ||
          server.port > 65535 ||
          server.path.isNotEmpty ||
          server.hasQuery ||
          server.hasFragment ||
          server.userInfo.isNotEmpty ||
          octets.length != 4 ||
          octets.any((part) => part == null || part < 0 || part > 255) ||
          octets.first == 0 ||
          octets.first == 127 ||
          octets.first! >= 224) {
        throw const FormatException();
      }
      final name = values['name'] ?? '';
      final code = values['code'] ?? '';
      final expires = int.tryParse(values['expires'] ?? '');
      if (name.trim().isEmpty ||
          name.length > 253 ||
          expires == null ||
          !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(code)) {
        throw const FormatException();
      }
      final expiresAt = DateTime.fromMillisecondsSinceEpoch(expires);
      if (!expiresAt.isAfter(now ?? DateTime.now())) {
        throw const PairingException('二维码已过期，请在电脑上刷新后重新扫码。');
      }
      return PairingLink(
        server: server,
        hostName: name,
        code: code,
        expiresAt: expiresAt,
      );
    } on PairingException {
      rethrow;
    } catch (_) {
      throw const PairingException('这不是有效的小梦绑定码，请扫描宿主机连接页面的二维码。');
    }
  }
}

String newPairingNonce() {
  final random = Random.secure();
  return base64UrlEncode(
    List.generate(32, (_) => random.nextInt(256)),
  ).replaceAll('=', '');
}

class PairingService {
  final http.Client _client;
  PairingService({http.Client? client}) : _client = client ?? http.Client();
  void close() => _client.close();

  Future<ServerSettings> exchange(
    PairingLink link, {
    required String clientNonce,
    required String installationId,
    required String deviceName,
    required String platform,
    ServerSettings? currentSettings,
  }) async {
    try {
      final request =
          http.Request('POST', link.server.resolve('/pair/exchange'))
            ..followRedirects = false
            ..headers['Content-Type'] = 'application/json'
            ..body = jsonEncode({
              'code': link.code,
              'clientNonce': clientNonce,
              'installationId': installationId,
              if (currentSettings?.baseUrl == link.server.toString() &&
                  currentSettings!.token.startsWith('xm_device_'))
                'existingToken': currentSettings.token,
              'deviceName': deviceName.trim(),
              'platform': platform,
            });
      final response = await _client
          .send(request)
          .then(http.Response.fromStream)
          .timeout(const Duration(seconds: 10));
      if (response.statusCode == 410) {
        throw const PairingException('二维码已过期或被刷新，请重新扫码。');
      }
      if (response.statusCode == 409) {
        final error = jsonDecode(response.body);
        if (error is Map && error['errorCode'] == 'DEVICE_ALREADY_PAIRED') {
          throw const PairingException(
            '这台设备已绑定此宿主机，无需重复绑定。原有连接仍然可用。',
            code: 'DEVICE_ALREADY_PAIRED',
          );
        }
        throw const PairingException('二维码已被使用，请在电脑上生成新的二维码。');
      }
      if (response.statusCode == 426) {
        throw const PairingException('请安装新版小梦 APP 后绑定。');
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw const PairingException('主机暂时无法完成绑定，请检查后端配置后重试。');
      }
      final data = jsonDecode(response.body);
      if (data is! Map ||
          data['serverUrl'] != link.server.toString() ||
          data['token'] is! String ||
          !RegExp(
            r'^xm_device_[A-Za-z0-9_-]{43}$',
          ).hasMatch(data['token'] as String)) {
        throw const PairingException('主机返回的绑定信息无效，请重新扫码。');
      }
      return ServerSettings(
        host: link.server.host,
        port: link.server.port,
        token: data['token'] as String,
      );
    } on PairingException {
      rethrow;
    } on TimeoutException {
      throw const PairingException('连接超时。请确认手机和电脑处于同一网络，检查网卡地址与防火墙后重试。');
    } on http.ClientException {
      throw const PairingException('无法连接这台电脑，请确认后端已启动，并允许小梦访问本地网络。');
    } on FormatException {
      throw const PairingException('主机返回的内容无法识别，请确认扫描的是小梦绑定码。');
    }
  }
}
