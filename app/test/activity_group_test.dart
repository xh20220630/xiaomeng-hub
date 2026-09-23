import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:claude_monitor/chat_builder.dart';
import 'package:claude_monitor/widgets/activity_group.dart';
import 'package:claude_monitor/widgets/markdown_text.dart';

void main() {
  testWidgets(
    'mobile activity hides raw logs and exposes full input and output on demand',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      final raw = 'Internal-node-31\n${'log line\n' * 2000}last output';
      final message = ChatMessage(
        ChatKind.toolBash,
        toolName: 'Terminal',
        toolArgs: 'npm test',
        toolOutput: raw,
        ok: false,
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(20),
              child: ActivityGroup(messages: [message]),
            ),
          ),
        ),
      );
      expect(find.textContaining('1 项操作未成功'), findsOneWidget);
      expect(find.textContaining('Internal-node-31'), findsNothing);
      await tester.tap(find.text('执行记录'));
      await tester.pumpAndSettle();
      expect(find.text('运行测试'), findsOneWidget);
      expect(find.textContaining('Internal-node-31'), findsNothing);
      await tester.tap(find.text('运行测试'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Internal-node-31'), findsOneWidget);
      expect(find.textContaining('last output'), findsNothing);
      await tester.tap(find.text('复制'));
      await tester.pump();
      expect(copied, raw);
      await tester.tap(find.text('输入'));
      await tester.pump();
      await tester.tap(find.text('复制'));
      await tester.pump();
      expect(copied, 'npm test');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'running and disconnected activity uses actual status without exposing logs',
    (tester) async {
      const messages = [
        ChatMessage(ChatKind.commentary, text: '正在检查页面布局'),
        ChatMessage(
          ChatKind.toolBash,
          toolName: 'Terminal',
          toolArgs: 'npm test',
          active: true,
        ),
      ];
      Widget host(bool offline) => MaterialApp(
        home: Scaffold(
          body: ActivityGroup(
            messages: messages,
            running: true,
            offline: offline,
          ),
        ),
      );
      await tester.pumpWidget(host(false));
      expect(find.text('正在检查页面布局'), findsOneWidget);
      expect(find.text('运行测试'), findsOneWidget);
      expect(find.text('npm test'), findsNothing);
      await tester.pumpWidget(host(true));
      expect(find.text('连接中断，等待同步'), findsOneWidget);
      expect(find.text('正在处理'), findsNothing);
    },
  );

  testWidgets('code blocks accept incomplete fences and copy the code only', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Padding(
            padding: EdgeInsets.all(20),
            child: SelectionArea(
              child: MarkdownText('示例\n\n```dart\nprint("hello");'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('复制代码'));
    await tester.pump();
    expect(copied?.trim(), 'print("hello");');
    expect(tester.takeException(), isNull);
  });
}
