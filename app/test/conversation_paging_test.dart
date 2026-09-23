import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:claude_monitor/models.dart';
import 'package:claude_monitor/services/api_service.dart';
import 'package:claude_monitor/state/history.dart';
import 'package:claude_monitor/state/monitor.dart';
import 'package:claude_monitor/widgets/chat_widgets.dart';
import 'package:claude_monitor/widgets/conversation_timeline.dart';

class _Monitor extends MonitorNotifier {
  @override
  MonitorState build() => const MonitorState();
}

class _Pages extends ApiService {
  _Pages(this.read) : super('http://localhost');
  final Future<HistoryPage> Function(String? cursor) read;
  final requested = <String?>[];
  @override
  Future<HistoryPage> getHistory(String sessionId, {String? cursor}) {
    requested.add(cursor);
    return read(cursor);
  }
}

List<TaskEvent> messages(int newest, int oldest) => [
  for (var i = newest; i >= oldest; i--)
    TaskEvent(
      sessionId: 's',
      eventKey: 'user$i',
      itemId: 'user$i',
      hookEventName: 'UserPromptSubmit',
      status: 'done',
      detail: 'Message $i',
    ),
];

Widget _host(_Pages api) => ProviderScope(
  overrides: [
    apiServiceProvider.overrideWithValue(api),
    monitorProvider.overrideWith(_Monitor.new),
  ],
  child: const MaterialApp(
    home: Scaffold(
      body: ConversationTimeline(
        project: Project(
          projectId: 'p',
          name: 'P',
          cwd: '/',
          status: 'done',
          sessions: [Session(sessionId: 's', status: 'done')],
        ),
        sessionId: 's',
      ),
    ),
  ),
);

ScrollPosition position(WidgetTester tester) => tester
    .state<ScrollableState>(
      find.descendant(
        of: find.byType(ListView),
        matching: find.byType(Scrollable),
      ),
    )
    .position;

void main() {
  testWidgets(
    'scrolling near the oldest message fetches one page and preserves the visible message',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final older = Completer<HistoryPage>();
      final api = _Pages(
        (cursor) async => cursor == null
            ? HistoryPage(messages(60, 31), 'older')
            : older.future,
      );
      await tester.pumpWidget(_host(api));
      await tester.pumpAndSettle();
      expect(api.requested, [null]);
      expect(find.text('加载更早的消息'), findsNothing);
      final scroll = position(tester);
      scroll.jumpTo(scroll.maxScrollExtent - 90);
      await tester.pump();
      await tester.pump();
      expect(api.requested, [null, 'older']);
      final visible =
          find
                  .byType(ChatBubble)
                  .evaluate()
                  .where((element) {
                    final y = tester
                        .getTopLeft(find.byWidget(element.widget))
                        .dy;
                    return y > 100 && y < 400;
                  })
                  .first
                  .widget
              as ChatBubble;
      Finder anchor() => find.byWidgetPredicate(
        (w) => w is ChatBubble && w.message.id == visible.message.id,
      );
      final before = tester.getTopLeft(anchor()).dy;
      scroll.jumpTo(scroll.pixels - 1);
      await tester.pump();
      expect(api.requested, [null, 'older']);
      older.complete(HistoryPage(messages(30, 1), null));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(anchor()).dy, closeTo(before, 2));
      scroll.jumpTo(scroll.maxScrollExtent);
      await tester.pumpAndSettle();
      expect(find.text('会话的起点'), findsOneWidget);
      expect(api.requested, [null, 'older']);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'short pages fill the viewport automatically and stop once it can scroll',
    (tester) async {
      final api = _Pages(
        (cursor) async => cursor == null
            ? HistoryPage(messages(40, 40), 'older')
            : HistoryPage(messages(39, 1), 'oldest'),
      );
      await tester.pumpWidget(_host(api));
      await tester.pumpAndSettle();
      expect(api.requested, [null, 'older']);
      expect(position(tester).maxScrollExtent, greaterThan(180));
      expect(position(tester).pixels, 0);
    },
  );

  testWidgets(
    'failed older pages wait for retry without resetting the history cursor',
    (tester) async {
      var fail = true;
      final api = _Pages((cursor) async {
        if (cursor == null) return HistoryPage(messages(40, 40), 'older');
        if (fail) throw StateError('连接暂时中断');
        return HistoryPage(messages(39, 1), null);
      });
      await tester.pumpWidget(_host(api));
      await tester.pumpAndSettle();
      expect(api.requested, [null, 'older']);
      expect(find.textContaining('连接暂时中断'), findsOneWidget);
      final context = tester.element(find.byType(ConversationTimeline));
      final container = ProviderScope.containerOf(context);
      await container.read(historyProvider('s').notifier).refresh();
      await tester.pumpAndSettle();
      expect(api.requested, [null, 'older', null]);
      fail = false;
      await tester.tap(find.text('重试'));
      await tester.pumpAndSettle();
      expect(api.requested, [null, 'older', null, 'older']);
      expect(find.textContaining('连接暂时中断'), findsNothing);
    },
  );
}
