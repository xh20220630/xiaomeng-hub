import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import 'monitor.dart';

class ConversationHistory {
  final List<TaskEvent> events;
  final String? cursor;
  final bool loading;
  final bool loadingOlder;
  final bool failedOlder;
  final String? error;
  const ConversationHistory({
    this.events = const [],
    this.cursor,
    this.loading = false,
    this.loadingOlder = false,
    this.failedOlder = false,
    this.error,
  });
}

class HistoryController extends Notifier<ConversationHistory> {
  HistoryController(this.sessionId);
  final String sessionId;
  bool _alive = true;
  bool _busy = false;
  Timer? _timer;

  @override
  ConversationHistory build() {
    ref.watch(apiServiceProvider);
    ref.listen(
      monitorProvider.select(
        (s) => s.serverProjects.values
            .expand((p) => p.sessions)
            .where((s) => s.sessionId == sessionId)
            .firstOrNull
            ?.updatedAt,
      ),
      (_, _) {
        _timer?.cancel();
        _timer = Timer(const Duration(milliseconds: 400), refresh);
      },
    );
    _alive = true;
    ref.onDispose(() {
      _alive = false;
      _timer?.cancel();
    });
    Future.microtask(refresh);
    return const ConversationHistory(loading: true);
  }

  Future<void> refresh() => _load(false);
  Future<void> loadMore() => _load(true);

  Future<void> _load(bool older) async {
    if (_busy || !_alive || (older && state.cursor == null)) return;
    _busy = true;
    _timer?.cancel();
    final olderError = !older && state.failedOlder ? state.error : null;
    final requestedCursor = state.cursor;
    state = ConversationHistory(
      events: state.events,
      cursor: state.cursor,
      loading: true,
      loadingOlder: older,
      failedOlder: olderError != null,
      error: olderError,
    );
    try {
      final page = await ref
          .read(apiServiceProvider)
          .getHistory(sessionId, cursor: older ? state.cursor : null);
      if (!_alive) return;
      if (older &&
          page.nextCursor != null &&
          page.nextCursor == requestedCursor) {
        throw StateError('历史分页未前进，请重试');
      }
      final seen = <String>{};
      final ordered = older
          ? [...state.events, ...page.events]
          : [...page.events, ...state.events];
      final merged = ordered
          .where(
            (e) => seen.add(
              e.eventKey ?? '${e.id}:${e.hookEventName}:${e.detail}',
            ),
          )
          .toList();
      state = ConversationHistory(
        events: merged,
        cursor: older || state.events.isEmpty ? page.nextCursor : state.cursor,
        failedOlder: olderError != null,
        error: olderError,
      );
    } catch (e) {
      if (_alive) {
        state = ConversationHistory(
          events: state.events,
          cursor: state.cursor,
          error: e.toString(),
          failedOlder: older || olderError != null,
        );
      }
    } finally {
      _busy = false;
    }
  }
}

final historyProvider = NotifierProvider.autoDispose
    .family<HistoryController, ConversationHistory, String>(
      HistoryController.new,
    );
