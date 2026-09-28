import 'dart:async';

import 'package:claude_monitor/chat_builder.dart';
import 'package:claude_monitor/widgets/chat_widgets.dart';
import 'package:claude_monitor/widgets/markdown_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:url_launcher_platform_interface/link.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

class _Launcher extends UrlLauncherPlatform {
  final opened = <String>[];
  final modes = <PreferredLaunchMode>[];
  bool succeeds = true;
  bool throws = false;
  Completer<bool>? pending;

  @override
  LinkDelegate? get linkDelegate => null;

  @override
  Future<bool> launchUrl(String url, LaunchOptions options) async {
    opened.add(url);
    modes.add(options.mode);
    if (throws) throw PlatformException(code: 'unavailable');
    return pending?.future ?? succeeds;
  }
}

Widget _answer(String text, {bool active = false}) => MaterialApp(
  home: Scaffold(
    body: SingleChildScrollView(
      child: ChatBubble(
        ChatMessage(ChatKind.assistantText, text: text, active: active),
      ),
    ),
  ),
);

Widget _markdown(String text) => MaterialApp(
  home: Scaffold(body: SelectionArea(child: MarkdownText(text))),
);

void main() {
  late _Launcher launcher;

  setUp(() {
    final previous = UrlLauncherPlatform.instance;
    launcher = _Launcher();
    UrlLauncherPlatform.instance = launcher;
    addTearDown(() => UrlLauncherPlatform.instance = previous);
  });

  testWidgets(
    'streamed answer links work when complete and after later deltas',
    (tester) async {
      await tester.pumpWidget(
        _answer('[文档](https://example.com', active: true),
      );
      expect(launcher.opened, isEmpty);

      await tester.pumpWidget(
        _answer('[文档](https://example.com/start?q=1#intro)', active: true),
      );
      await tester.tap(find.text('文档', findRichText: true));
      await tester.pump();
      expect(launcher.opened, ['https://example.com/start?q=1#intro']);

      await tester.pumpWidget(
        _answer(
          '[文档](https://example.com/start?q=1#intro)\n\n还在生成。',
          active: true,
        ),
      );
      await tester.tap(find.text('文档', findRichText: true));
      await tester.pump();
      expect(launcher.opened.length, 2);

      await tester.pumpWidget(
        _answer('[文档](https://example.com/final)\n\n已完成。'),
      );
      await tester.tap(find.text('文档', findRichText: true));
      await tester.pump();
      expect(launcher.opened.last, 'https://example.com/final');
      expect(
        launcher.modes,
        everyElement(PreferredLaunchMode.externalApplication),
      );
      expect(tester.takeException(), isNull);
    },
  );

  for (final throws in [false, true]) {
    testWidgets(
      'failed launcher (throws: $throws) offers the exact link to copy',
      (tester) async {
        launcher.succeeds = false;
        launcher.throws = throws;
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
        await tester.pumpWidget(_answer('[下载](https://example.com/app.apk)'));
        await tester.tap(find.text('下载', findRichText: true));
        await tester.pumpAndSettle();
        expect(find.text('无法打开链接'), findsOneWidget);
        await tester.tap(find.text('复制链接'));
        await tester.pump();
        expect(copied, 'https://example.com/app.apk');
        await tester.tap(find.text('关闭'));
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );
  }

  for (final path in [
    r'D:\project\app.dart:12',
    '/workspace/app.dart#L12',
    '../src/app.dart',
    'file:///D:/project/app.dart',
  ]) {
    testWidgets(
      'host file $path shows its address without launching on phone',
      (tester) async {
        await tester.pumpWidget(_markdown('[源文件]($path)'));
        await tester.tap(find.text('源文件', findRichText: true));
        await tester.pumpAndSettle();
        expect(find.text('电脑文件'), findsOneWidget);
        expect(find.text(path), findsOneWidget);
        expect(find.text('复制路径'), findsOneWidget);
        expect(launcher.opened, isEmpty);
      },
    );
  }

  for (final url in ['javascript:alert(1)', 'https://', '#section']) {
    testWidgets('unsupported or incomplete link $url gives feedback', (
      tester,
    ) async {
      await tester.pumpWidget(_markdown('[链接]($url)'));
      await tester.tap(find.text('链接', findRichText: true));
      await tester.pumpAndSettle();
      expect(find.text('无法打开链接'), findsOneWidget);
      expect(find.text('复制链接'), findsOneWidget);
      expect(launcher.opened, isEmpty);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('angle brackets and protocol-relative web links open correctly', (
    tester,
  ) async {
    await tester.pumpWidget(_markdown('[文档](<https://example.com/guide>)'));
    await tester.tap(find.text('文档', findRichText: true));
    await tester.pump();
    await tester.pumpWidget(_markdown('[文档](//example.com/guide)'));
    await tester.tap(find.text('文档', findRichText: true));
    await tester.pump();
    expect(launcher.opened, List.filled(2, 'https://example.com/guide'));
  });

  testWidgets(
    'launch failure after leaving the answer does not use stale context',
    (tester) async {
      launcher.pending = Completer<bool>();
      await tester.pumpWidget(_answer('[文档](https://example.com/guide)'));
      await tester.tap(find.text('文档', findRichText: true));
      await tester.pumpWidget(const MaterialApp(home: Scaffold()));
      launcher.pending!.complete(false);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
