import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:claude_monitor/services/app_updates.dart';
import 'package:claude_monitor/state/app_updates.dart';
import 'package:claude_monitor/screens/app_version_screen.dart';
import 'package:claude_monitor/theme/app_theme.dart';
import 'package:claude_monitor/widgets/app_update_coordinator.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

final hash = List.filled(64, 'a').join();
const base = 'https://github.com/$updateRepository/releases/download';

Map<String, dynamic> releaseJson({
  String version = '2.0.3',
  int build = 18,
  bool preview = true,
  bool draft = false,
  bool manifest = false,
  String? digest,
}) => {
  'draft': draft,
  'prerelease': preview,
  'body': '新增版本管理',
  'assets': [
    {
      'name': 'xiaomeng-v$version${manifest ? '' : '-build$build'}-android.apk',
      'browser_download_url': '$base/v$version/app.apk',
      'size': 1234,
      'digest': digest ?? 'sha256:$hash',
    },
    if (manifest)
      {
        'name': 'release-manifest.json',
        'browser_download_url': '$base/v$version/release-manifest.json',
      },
  ],
};

ReleaseClient clientFor(List<Map<String, dynamic>> releases) => ReleaseClient(
  MockClient(
    (_) async => http.Response(
      jsonEncode(releases),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    ),
  ),
);

class FakePlatform extends UpdatePlatform {
  int downloads = 0;
  int installs = 0;
  bool permission = true;
  bool debug = true;
  String? cached;
  bool? lastWifiOnly;
  Completer<void>? downloading;
  Object? downloadError;

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
    'debugSigned': debug,
    'ready': cached,
    'canInstall': permission,
  };
  @override
  Future<void> clear() async {
    cached = null;
  }

  @override
  Future<void> download(AppRelease release, {required bool wifiOnly}) async {
    downloads++;
    lastWifiOnly = wifiOnly;
    if (downloadError != null) throw downloadError!;
    if (downloading != null) await downloading!.future;
    cached = jsonEncode(release.toJson());
  }

  @override
  Future<void> cancel() async => downloading?.completeError(
    PlatformException(code: 'cancelled', message: '下载已取消'),
  );
  @override
  Future<bool> install() async {
    installs++;
    return permission;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'compares numeric versions, prereleases and build numbers without downgrades',
    () {
      expect(
        const AppVersion(
          '2.0.10',
          20,
        ).isNewerThan(const AppVersion('2.0.9', 19)),
        isTrue,
      );
      expect(
        const AppVersion(
          '2.0.3-rc.10',
          20,
        ).compareTo(const AppVersion('2.0.3-rc.2', 19)),
        greaterThan(0),
      );
      expect(
        const AppVersion(
          '2.0.3',
          21,
        ).compareTo(const AppVersion('2.0.3-rc.10', 20)),
        greaterThan(0),
      );
      expect(
        const AppVersion(
          '2.0.3',
          18,
        ).isNewerThan(const AppVersion('2.0.3', 18)),
        isFalse,
      );
      expect(
        const AppVersion(
          '2.0.3',
          19,
        ).isNewerThan(const AppVersion('2.0.3', 18)),
        isTrue,
      );
      expect(
        const AppVersion(
          '2.0.4',
          17,
        ).isNewerThan(const AppVersion('2.0.3', 18)),
        isFalse,
      );
      expect(
        const AppVersion(
          '2.0.2',
          20,
        ).isNewerThan(const AppVersion('2.0.3', 18)),
        isFalse,
      );
    },
  );

  test('only accepts assets from the configured HTTPS GitHub repository', () {
    expect(isReleaseAssetUrl('$base/v2/app.apk'), isTrue);
    for (final url in [
      'http://github.com/$updateRepository/releases/download/a.apk',
      'https://github.com.evil.test/$updateRepository/releases/download/a.apk',
      'https://github.com/other/repo/releases/download/a.apk',
      'https://user@github.com/$updateRepository/releases/download/a.apk',
    ]) {
      expect(isReleaseAssetUrl(url), isFalse);
    }
  });

  test(
    'selects newest eligible release regardless of API order and ignores drafts',
    () async {
      final api = clientFor([
        releaseJson(version: '2.0.3', build: 18),
        releaseJson(version: '2.0.5', build: 20, draft: true),
        releaseJson(version: '2.0.4', build: 19),
      ]);
      expect(
        (await api.latest(const AppVersion('2.0.2', 17), true))?.version.name,
        '2.0.4',
      );
      expect(await api.latest(const AppVersion('2.0.2', 17), false), isNull);
      expect(await api.latest(const AppVersion('2.0.4', 19), true), isNull);
    },
  );

  test(
    'reads build number and checksum from formal release manifest',
    () async {
      final api = ReleaseClient(
        MockClient((request) async {
          if (request.url.path.endsWith('.json')) {
            return http.Response(
              jsonEncode({
                'version': '2.0.3',
                'buildNumber': 18,
                'artifacts': [
                  {
                    'name': 'xiaomeng-v2.0.3-android.apk',
                    'bytes': 1234,
                    'sha256': hash,
                  },
                ],
              }),
              200,
            );
          }
          return http.Response(
            jsonEncode([
              releaseJson(preview: false, manifest: true, digest: ''),
            ]),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      final result = await api.latest(const AppVersion('2.0.2', 17), false);
      expect(result?.version.build, 18);
      expect(result?.sha256, hash);
    },
  );

  test('rejects missing checksum and reports GitHub rate limiting', () async {
    await expectLater(
      clientFor([
        releaseJson(digest: ''),
      ]).latest(const AppVersion('2.0.2', 17), true),
      throwsA(isA<UpdateException>()),
    );
    final api = ReleaseClient(
      MockClient((_) async => http.Response('{}', 403)),
    );
    await expectLater(
      api.latest(const AppVersion('2.0.2', 17), true),
      throwsA(isA<UpdateException>()),
    );
  });

  test(
    'rejects a release whose manifest contradicts the GitHub checksum',
    () async {
      final api = ReleaseClient(
        MockClient((request) async {
          final data = request.url.path.endsWith('.json')
              ? {
                  'version': '2.0.3',
                  'buildNumber': 18,
                  'artifacts': [
                    {
                      'name': 'xiaomeng-v2.0.3-android.apk',
                      'bytes': 1234,
                      'sha256': List.filled(64, 'b').join(),
                    },
                  ],
                }
              : [releaseJson(manifest: true)];
          return http.Response(
            jsonEncode(data),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      await expectLater(
        api.latest(const AppVersion('2.0.2', 17), true),
        throwsA(isA<UpdateException>()),
      );
    },
  );

  Future<AppUpdates> create(
    FakePlatform platform, {
    Map<String, Object> preferences = const {},
  }) async {
    SharedPreferences.setMockInitialValues(preferences);
    final prefs = await SharedPreferences.getInstance();
    final updates = AppUpdates(prefs, clientFor([releaseJson()]), platform);
    addTearDown(updates.dispose);
    return updates;
  }

  test(
    'automatic check downloads only on Wi-Fi and never starts installer',
    () async {
      final platform = FakePlatform();
      final updates = await create(platform);
      await updates.checkAutomatic();
      expect(updates.ready, isTrue);
      expect(platform.lastWifiOnly, isTrue);
      expect(platform.installs, 0);
      final checked = updates.lastChecked;
      await updates.checkAutomatic();
      expect(updates.lastChecked, checked);
      expect(platform.downloads, 1);
    },
  );

  test(
    'preferences disable automatic work and production defaults to stable',
    () async {
      final platform = FakePlatform()..debug = false;
      final updates = await create(
        platform,
        preferences: {
          'updates.autoCheck': false,
          'updates.autoDownload': false,
        },
      );
      await updates.checkAutomatic();
      expect(updates.lastChecked, isNull);
      expect(updates.previews, isFalse);
      await updates.setOption('previews', true);
      expect(updates.available, isNotNull);
      expect(platform.downloads, 0);
      await updates.download();
      expect(platform.lastWifiOnly, isFalse);
    },
  );

  test(
    'download failure cannot enable install, manual retry recovers',
    () async {
      final platform = FakePlatform()
        ..downloadError = PlatformException(code: 'hash', message: '校验失败');
      final updates = await create(platform);
      await updates.check();
      expect(updates.ready, isFalse);
      expect(updates.message, '校验失败');
      await updates.install();
      expect(platform.installs, 0);
      platform.downloadError = null;
      await updates.download();
      expect(updates.ready, isTrue);
    },
  );

  test(
    'cancel stops download, avoids immediate automatic restart, allows retry',
    () async {
      final platform = FakePlatform()..downloading = Completer<void>();
      final updates = await create(
        platform,
        preferences: {'updates.autoDownload': false},
      );
      await updates.check();
      final download = updates.download();
      expect(updates.downloading, isTrue);
      await updates.cancel();
      await download;
      expect(updates.ready, isFalse);
      await updates.setOption('autoDownload', true);
      expect(platform.downloads, 1);
      platform.downloading = null;
      await updates.download();
      expect(updates.ready, isTrue);
    },
  );

  test(
    'returns from install permission settings and resumes installation once',
    () async {
      final platform = FakePlatform()..permission = false;
      final updates = await create(platform);
      await updates.check();
      await updates.install();
      expect(updates.waitingForPermission, isTrue);
      platform.permission = true;
      await updates.foreground(true);
      expect(platform.installs, 2);
      expect(updates.waitingForPermission, isFalse);
      await updates.foreground(true);
      expect(platform.installs, 2);
    },
  );

  test('restores a completed download after restart', () async {
    final platform = FakePlatform();
    final updates = await create(platform);
    await updates.check();
    final restored = await create(platform);
    await restored.initialize();
    expect(restored.ready, isTrue);
    expect(restored.available?.version.build, 18);
  });

  testWidgets(
    'startup coordinator checks once and surfaces a completed update',
    (tester) async {
      final updates = await create(
        FakePlatform(),
        preferences: {'updates.autoDownload': false},
      );
      var opened = 0;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appUpdatesProvider.overrideWithValue(updates)],
          child: MaterialApp(
            builder: (context, child) =>
                AppUpdateCoordinator(onOpen: () => opened++, child: child!),
            home: const Scaffold(body: Text('小梦')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('发现新版本 2.0.3'), findsOneWidget);
      await tester.tap(find.text('查看'));
      expect(opened, 1);
      await tester.tap(find.byKey(const Key('dismiss-update')));
      await tester.pump();
      expect(find.text('查看'), findsNothing);
      await updates.download();
      await tester.pumpAndSettle();
      expect(find.text('去安装'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('version page shows install state and fits a narrow phone', (
    tester,
  ) async {
    const output = String.fromEnvironment('UI_REVIEW_DIR');
    if (output.isNotEmpty) {
      await tester.runAsync(() async {
        final icons = FontLoader('MaterialIcons')
          ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
        await icons.load();
        final font = File(
          Platform.isWindows
              ? r'C:\Windows\Fonts\msyh.ttc'
              : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        );
        if (await font.exists()) {
          final bytes = ByteData.sublistView(await font.readAsBytes());
          for (final family in ['Noto Sans SC', 'Microsoft YaHei', 'Roboto']) {
            await (FontLoader(family)..addFont(Future.value(bytes))).load();
          }
        }
      });
    }
    final updates = await create(FakePlatform());
    await updates.check();
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final boundary = GlobalKey();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appUpdatesProvider.overrideWithValue(updates)],
        child: RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(),
            home: const AppVersionScreen(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('2.0.2（build 17）'), findsOneWidget);
    expect(find.text('安装更新'), findsOneWidget);
    expect(tester.takeException(), isNull);
    if (output.isNotEmpty) {
      await tester.runAsync(() async {
        final render =
            boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await render.toImage(pixelRatio: 2);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(output).create(recursive: true);
        await File(
          '$output/app-version.png',
        ).writeAsBytes(data!.buffer.asUint8List());
        image.dispose();
      });
    }
    tester.view.physicalSize = const Size(320, 640);
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView), const Offset(0, -600));
    await tester.pumpAndSettle();
    expect(find.text('自动下载更新'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
