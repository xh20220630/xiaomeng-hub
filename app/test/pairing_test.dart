import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:claude_monitor/services/pairing_service.dart';
import 'package:claude_monitor/state/device_identity.dart';
import 'package:claude_monitor/state/settings.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final now = DateTime(2026, 9, 19, 12);
  final code = 'a' * 43;
  String payload({
    String server = 'http://192.168.1.22:4820',
    int? expires,
  }) => Uri(
    scheme: 'xiaomeng',
    host: 'pair',
    queryParameters: {
      'v': '1',
      'server': server,
      'name': '我的电脑',
      'code': code,
      'expires':
          '${expires ?? now.add(const Duration(minutes: 2)).millisecondsSinceEpoch}',
    },
  ).toString();

  test('parses the server QR contract including Unicode host names', () {
    final link = PairingLink.parse(payload(), now: now);
    expect(link.hostName, '我的电脑');
    expect(link.server.host, '192.168.1.22');
    expect(link.server.port, 4820);
    expect(link.code, code);
  });

  test('rejects expired, unrelated, ambiguous and unsafe QR payloads', () {
    for (final raw in [
      'https://example.com',
      payload(expires: now.millisecondsSinceEpoch),
      '${payload()}&code=another',
      payload().replaceFirst('v=1', 'v=2'),
      for (final server in [
        'file:///tmp',
        'http://localhost:4820',
        'http://127.0.0.1:4820',
        'http://192.168.1.22:4820/path',
        'http://user:secret@192.168.1.22:4820',
        'http://192.168.1.22:4820?token=secret',
        'http://224.0.0.1:4820',
        'https://192.168.1.22:4820',
      ])
        payload(server: server),
    ]) {
      expect(
        () => PairingLink.parse(raw, now: now),
        throwsA(isA<PairingException>()),
      );
    }
  });

  test(
    'exchanges only the temporary secret and derives settings from the scanned address',
    () async {
      final link = PairingLink.parse(payload(), now: now);
      final nonce = newPairingNonce();
      expect(nonce, matches(RegExp(r'^[A-Za-z0-9_-]{43}$')));
      final service = PairingService(
        client: MockClient((request) async {
          expect(
            request.url.toString(),
            'http://192.168.1.22:4820/pair/exchange',
          );
          expect(request.followRedirects, false);
          expect(request.headers.containsKey('authorization'), false);
          expect(jsonDecode(request.body)['clientNonce'], nonce);
          expect(jsonDecode(request.body)['installationId'], code);
          return http.Response(
            jsonEncode({
              'serverUrl': link.server.toString(),
              'token': 'xm_device_$code',
            }),
            201,
          );
        }),
      );
      addTearDown(service.close);
      final settings = await service.exchange(
        link,
        clientNonce: nonce,
        installationId: code,
        deviceName: 'Phone',
        platform: 'android',
      );
      expect(settings.baseUrl, link.server.toString());
      expect(settings.token, 'xm_device_$code');
      expect(settings.wsUrl, contains('token=xm_device_'));
    },
  );

  test(
    'rejects a changed host, malformed credentials, used codes and HTTP redirects',
    () async {
      final link = PairingLink.parse(payload(), now: now);
      for (final response in [
        http.Response(
          jsonEncode({
            'serverUrl': 'http://192.168.1.23:4820',
            'token': 'xm_device_$code',
          }),
          201,
        ),
        http.Response(
          jsonEncode({
            'serverUrl': link.server.toString(),
            'token': 'master-token',
          }),
          201,
        ),
        http.Response('{}', 409),
        http.Response('{}', 410),
        http.Response('{}', 302),
        http.Response('<html>Not the pairing service</html>', 200),
      ]) {
        final service = PairingService(
          client: MockClient((_) async => response),
        );
        addTearDown(service.close);
        await expectLater(
          service.exchange(
            link,
            clientNonce: newPairingNonce(),
            installationId: code,
            deviceName: 'Phone',
            platform: 'ios',
          ),
          throwsA(isA<PairingException>()),
        );
      }
    },
  );

  test(
    'installation identity survives preference reloads and host changes',
    () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final first = await loadPairingIdentity(prefs);
      await prefs.setString('host', '192.168.1.50');
      await prefs.setString('token', 'another-host-token');
      await prefs.reload();
      expect(await loadPairingIdentity(prefs), first);
      expect(first, matches(RegExp(r'^[A-Za-z0-9_-]{43}$')));
    },
  );

  test(
    'duplicate enrollment is explicit and old credentials only go to the same server',
    () async {
      final link = PairingLink.parse(payload(), now: now);
      for (final sameServer in [true, false]) {
        final service = PairingService(
          client: MockClient((request) async {
            expect(
              jsonDecode(request.body).containsKey('existingToken'),
              sameServer,
            );
            return http.Response(
              jsonEncode({'errorCode': 'DEVICE_ALREADY_PAIRED'}),
              409,
            );
          }),
        );
        addTearDown(service.close);
        await expectLater(
          service.exchange(
            link,
            clientNonce: newPairingNonce(),
            installationId: code,
            deviceName: 'Renamed phone',
            platform: 'android',
            currentSettings: ServerSettings(
              host: sameServer ? '192.168.1.22' : '192.168.1.23',
              port: 4820,
              token: 'xm_device_$code',
            ),
          ),
          throwsA(
            isA<PairingException>().having(
              (error) => error.code,
              'code',
              'DEVICE_ALREADY_PAIRED',
            ),
          ),
        );
      }
    },
  );
}
