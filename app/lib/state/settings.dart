import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Overridden in main() with the real instance.
final sharedPrefsProvider = Provider<SharedPreferences>(
  (ref) => throw UnimplementedError('sharedPrefsProvider must be overridden'),
);

class ServerSettings {
  final String host;
  final int port;

  /// Master token for manual setup, or a revocable device token from QR pairing.
  final String token;

  const ServerSettings({required this.host, required this.port, this.token = ''});

  String get baseUrl => 'http://$host:$port';

  /// WS handshake carries the token as ?token= per the cross-end contract.
  String get wsUrl {
    final base = 'ws://$host:$port/ws';
    if (token.isEmpty) return base;
    return '$base?token=${Uri.encodeQueryComponent(token)}';
  }
}

class SettingsNotifier extends Notifier<ServerSettings> {
  @override
  ServerSettings build() {
    final prefs = ref.watch(sharedPrefsProvider);
    return ServerSettings(
      host: prefs.getString('host') ?? 'localhost',
      port: prefs.getInt('port') ?? 4820,
      token: prefs.getString('token') ?? '',
    );
  }

  Future<void> update(String host, int port, {String token = ''}) async {
    final prefs = ref.read(sharedPrefsProvider);
    await prefs.setString('host', host);
    await prefs.setInt('port', port);
    await prefs.setString('token', token);
    state = ServerSettings(host: host, port: port, token: token);
  }
}

final settingsProvider =
    NotifierProvider<SettingsNotifier, ServerSettings>(SettingsNotifier.new);
