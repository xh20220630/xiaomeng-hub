import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:claude_monitor/screens/app_version_screen.dart';
import 'package:claude_monitor/services/app_updates.dart';
import 'package:claude_monitor/state/app_updates.dart';
import 'package:claude_monitor/state/release_history.dart';
import 'package:claude_monitor/theme/app_theme.dart';
import 'package:claude_monitor/widgets/markdown_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> note(
  int id,
  String version, {
  bool preview = true,
  String? body,
}) => {
  'id': id,
  'tag_name': 'preview-$version-build${id + 15}',
  'name': '小梦 $version',
  'draft': false,
  'prerelease': preview,
  'published_at': '2026-09-${(id + 23).toString().padLeft(2, '0')}T09:00:00Z',
  'html_url': 'https://github.com/$updateRepository/releases/tag/v$version',
  'body':
      body ??
      '## 更新内容\n\n- **版本更新管理**：在应用内检查与下载新版。\n- **实时通知**：全新小梦状态卡片。\n- **链接修复**：回答中的链接可以点击。',
  'assets': [],
};

http.Response response(Object value, {int status = 200}) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

class _Platform extends UpdatePlatform {
  int downloads = 0;
  @override
  bool get supported => true;
  @override
  void onProgress(void Function(double) listener) {}
  @override
  void dispose() {}
  @override
  Future<Map<String, dynamic>> info() async => {
    'version': '2.0.2',
    'build': 17,
    'debugSigned': true,
  };
  @override
  Future<void> download(AppRelease release, {required bool wifiOnly}) async {
    downloads++;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SharedPreferences prefs;
  setUp(() async {
    SharedPreferences.setMockInitialValues({'updates.autoDownload': false});
    prefs = await SharedPreferences.getInstance();
  });

  test(
    'history reads old notes without APKs, ignores drafts and rejects foreign URLs',
    () async {
      final api = ReleaseClient(
        MockClient((request) async {
          expect(request.url.queryParameters, {'per_page': '20', 'page': '1'});
          return response([
            note(5, '2.0.5'),
            {
              ...note(2, '2.0.2', preview: false),
              'html_url': 'https://other.example/releases',
            },
            {...note(6, '2.0.6'), 'draft': true},
            {'tag_name': 'v1.0.0', 'name': '历史版本', 'body': null},
            {'tag_name': 'broken', 'assets': 'invalid'},
          ]);
        }),
      );
      final page = await api.history();
      expect(page.entries.map((entry) => entry.version), [
        '2.0.5',
        '2.0.2',
        '1.0.0',
      ]);
      expect(page.entries.first.build, 20);
      expect(page.entries.first.notes, contains('**版本更新管理**'));
      expect(page.entries.first.summary, '版本更新管理：在应用内检查与下载新版。');
      expect(page.entries[1].url, isNull);
      expect(page.entries[2].notes, isEmpty);
      expect(page.entries[2].dateLabel, '发布日期未提供');
      expect(page.hasMore, isFalse);
    },
  );

  test(
    'pagination deduplicates releases and refresh replaces stale entries',
    () async {
      final pages = <int>[];
      var refresh = false;
      final api = ReleaseClient(
        MockClient((request) async {
          final page = int.parse(request.url.queryParameters['page']!);
          pages.add(page);
          if (refresh) return response([note(5, '2.0.5')]);
          if (page == 1) {
            return response(
              List.generate(20, (index) => note(index, '1.0.$index')),
            );
          }
          return response([note(19, '1.0.19'), note(22, '2.0.0')]);
        }),
        cacheDuration: Duration.zero,
      );
      final history = ReleaseHistory(api, prefs);
      addTearDown(history.dispose);
      await history.load();
      expect(history.entries.length, 20);
      expect(history.hasMore, isTrue);
      await history.load();
      expect(history.entries.length, 21);
      expect(history.hasMore, isFalse);
      await history.load();
      expect(pages, [1, 2]);
      refresh = true;
      await history.load(refresh: true);
      expect(history.entries.single.version, '2.0.5');
      expect(pages, [1, 2, 1]);
    },
  );

  test(
    'failed refresh retains cached history and successful retry clears the error',
    () async {
      var offline = false;
      final api = ReleaseClient(
        MockClient(
          (_) async => offline
              ? response({}, status: 403)
              : response([note(2, '2.0.2'), note(5, '2.0.5')]),
        ),
        cacheDuration: Duration.zero,
      );
      final original = ReleaseHistory(api, prefs);
      await original.load();
      expect(original.entries.first.version, '2.0.5');
      original.dispose();
      final restored = ReleaseHistory(api, prefs);
      addTearDown(restored.dispose);
      expect(restored.fromCache, isTrue);
      offline = true;
      await restored.load();
      expect(restored.error, contains('拒绝访问'));
      expect(restored.entries.length, 2);
      expect(restored.fromCache, isTrue);
      offline = false;
      await restored.load(refresh: true);
      expect(restored.error, isNull);
      expect(restored.fromCache, isFalse);
    },
  );

  test(
    'corrupt cache is ignored and disposing during a request is safe',
    () async {
      await prefs.setString(ReleaseHistory.cacheKey, '{broken');
      final pending = Completer<http.Response>();
      final history = ReleaseHistory(
        ReleaseClient(MockClient((_) => pending.future)),
        prefs,
      );
      expect(history.entries, isEmpty);
      final load = history.load();
      history.dispose();
      pending.complete(response([note(5, '2.0.5')]));
      await load;
      expect(history.entries, isEmpty);
    },
  );

  testWidgets(
    'history renders Markdown, filters channels, expands older notes and keeps update controls separate',
    (tester) async {
      const output = String.fromEnvironment('VERSION_REVIEW_DIR');
      if (output.isNotEmpty) {
        await tester.runAsync(() async {
          await (FontLoader('MaterialIcons')
                ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf')))
              .load();
          final font = File(
            Platform.isWindows
                ? r'C:\Windows\Fonts\msyh.ttc'
                : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          );
          if (await font.exists()) {
            final data = ByteData.sublistView(await font.readAsBytes());
            for (final family in [
              'Noto Sans SC',
              'Microsoft YaHei',
              'Roboto',
            ]) {
              await (FontLoader(family)..addFont(Future.value(data))).load();
            }
          }
        });
      }
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final latest = note(5, '2.0.5');
      final old = note(2, '2.0.2', body: '## 首个公开测试包\n\n支持连接宿主机、查看任务与审批。');
      final api = ReleaseClient(
        MockClient((_) async => response([latest, old])),
      );
      final platform = _Platform();
      final updates = AppUpdates(prefs, api, platform);
      await updates.initialize();
      updates.available = AppRelease(
        version: const AppVersion('2.0.5', 20),
        url:
            'https://github.com/$updateRepository/releases/download/v2.0.5/app.apk',
        sha256: 'a' * 64,
        bytes: 91913264,
        notes: latest['body'] as String,
        preview: true,
      );
      final history = ReleaseHistory(api, prefs);
      await history.load();
      addTearDown(updates.dispose);
      addTearDown(history.dispose);
      final boundary = GlobalKey();
      Widget host({double scale = 1}) => ProviderScope(
        overrides: [
          appUpdatesProvider.overrideWithValue(updates),
          releaseHistoryProvider.overrideWithValue(history),
        ],
        child: RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: const AppVersionScreen(),
          ),
        ),
      );
      await tester.pumpWidget(host());
      await tester.runAsync(
        () => precacheImage(
          const AssetImage('assets/ui-v3/mascot-avatar.png'),
          tester.element(find.byType(AppVersionScreen)),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('下载更新 · 87.7 MB'), findsOneWidget);
      expect(find.text(latest['body'] as String), findsNothing);
      expect(find.byType(MarkdownText), findsOneWidget);
      if (output.isNotEmpty) {
        await capture(tester, boundary, output, 'overview');
      }

      await tester.tap(find.text('版本历史'));
      await tester.pumpAndSettle();
      expect(find.text('每次进步，都有记录'), findsOneWidget);
      expect(find.text('下载更新 · 87.7 MB'), findsNothing);
      expect(find.text('2026.09.28 · build 20'), findsOneWidget);
      if (output.isNotEmpty) await capture(tester, boundary, output, 'history');
      await tester.tap(find.widgetWithText(ChoiceChip, '正式版'));
      await tester.pumpAndSettle();
      expect(find.text('暂无正式版记录'), findsOneWidget);
      await tester.tap(find.widgetWithText(ChoiceChip, '全部'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('2.0.5').last);
      await tester.pumpAndSettle();
      if (output.isNotEmpty) {
        await capture(tester, boundary, output, 'history-expanded');
      }
      await tester.scrollUntilVisible(
        find.text('收起说明').hitTestable(),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('收起说明'));
      await tester.pumpAndSettle();
      expect(find.text('收起说明'), findsNothing);
      await tester.ensureVisible(find.text('2.0.2'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('2.0.2'));
      await tester.pumpAndSettle();
      expect(find.text('首个公开测试包', findRichText: true), findsOneWidget);
      expect(platform.downloads, 0);
      expect(tester.takeException(), isNull);

      tester.view.physicalSize = const Size(320, 640);
      await tester.pumpWidget(host(scale: 1.5));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('更新偏好'));
      await tester.pumpAndSettle();
      expect(find.text('自动下载更新'), findsOneWidget);
      expect(tester.takeException(), isNull);
      if (output.isNotEmpty) {
        await capture(tester, boundary, output, 'preferences-large-text');
      }
    },
  );

  testWidgets(
    'up-to-date installs still show their release notes and history',
    (tester) async {
      final api = ReleaseClient(
        MockClient((_) async => response([note(2, '2.0.2')])),
      );
      final platform = _Platform();
      final updates = AppUpdates(prefs, api, platform);
      await updates.initialize();
      final history = ReleaseHistory(api, prefs);
      await history.load();
      addTearDown(updates.dispose);
      addTearDown(history.dispose);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            appUpdatesProvider.overrideWithValue(updates),
            releaseHistoryProvider.overrideWithValue(history),
          ],
          child: MaterialApp(
            theme: buildAppTheme(),
            home: const AppVersionScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('当前版本更新说明'), findsOneWidget);
      expect(find.byType(MarkdownText), findsOneWidget);
      expect(find.text('发现新版本'), findsNothing);
      expect(platform.downloads, 0);
    },
  );
}

Future<void> capture(
  WidgetTester tester,
  GlobalKey key,
  String directory,
  String name,
) async {
  await tester.runAsync(() async {
    final render =
        key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await render.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(directory).create(recursive: true);
    await File(
      '$directory/$name.png',
    ).writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}
