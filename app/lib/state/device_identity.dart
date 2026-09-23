import 'dart:convert';
import 'dart:math';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'settings.dart';

final pairingIdentityProvider = FutureProvider<String>(
  (ref) => loadPairingIdentity(ref.watch(sharedPrefsProvider)),
);

Future<String> loadPairingIdentity(SharedPreferences prefs) async {
  const key = 'pairing_installation_id';
  final existing = prefs.getString(key);
  if (existing != null && RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(existing)) {
    return existing;
  }
  // An installation identity survives renames, reconnects and app upgrades; a scan nonce does not.
  final random = Random.secure();
  final identity = base64UrlEncode(
    List.generate(32, (_) => random.nextInt(256)),
  ).replaceAll('=', '');
  if (!await prefs.setString(key, identity)) throw StateError('无法保存设备标识，请重试');
  return identity;
}
