import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../services/app_updates.dart';
import 'app_updates.dart';

final releaseHistoryProvider = Provider<ReleaseHistory>((ref) {
  final updates = ref.watch(appUpdatesProvider);
  final history = ReleaseHistory(updates.releases, updates.prefs);
  ref.onDispose(history.dispose);
  return history;
});

class ReleaseHistory extends ChangeNotifier {
  static const cacheKey = 'updates.releaseHistory.v1';
  final ReleaseClient client;
  final SharedPreferences prefs;
  List<ReleaseHistoryEntry> entries = [];
  bool loading = false;
  bool loaded = false;
  bool hasMore = false;
  bool fromCache = false;
  String? error;
  int _nextPage = 1;
  bool _disposed = false;

  ReleaseHistory(this.client, this.prefs) {
    try {
      final cached = prefs.getString(cacheKey);
      if (cached != null) {
        entries = (jsonDecode(cached) as List)
            .cast<Map<String, dynamic>>()
            .map(ReleaseHistoryEntry.fromJson)
            .toList();
        fromCache = entries.isNotEmpty;
      }
    } catch (_) {
      entries = [];
    }
  }

  Future<void> load({bool refresh = false}) async {
    if (_disposed || loading || (!refresh && loaded && !hasMore)) return;
    loading = true;
    error = null;
    notifyListeners();
    final page = refresh || !loaded ? 1 : _nextPage;
    try {
      final result = await client.history(page: page);
      if (_disposed) return;
      final merged = {
        if (page > 1)
          for (final entry in entries) entry.id: entry,
        for (final entry in result.entries) entry.id: entry,
      };
      entries = merged.values.toList()
        ..sort(
          (a, b) => (b.publishedAt ?? DateTime(1970)).compareTo(
            a.publishedAt ?? DateTime(1970),
          ),
        );
      _nextPage = page + 1;
      hasMore = result.hasMore;
      loaded = true;
      fromCache = false;
      try {
        await prefs.setString(
          cacheKey,
          jsonEncode(entries.take(20).map((entry) => entry.toJson()).toList()),
        );
      } catch (_) {
        // Cache failures must not hide successfully fetched release notes.
      }
    } catch (exception) {
      if (!_disposed) {
        error = exception is UpdateException
            ? exception.message
            : '暂时无法加载版本历史，请检查网络后重试';
      }
    } finally {
      loading = false;
      if (!_disposed) notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
