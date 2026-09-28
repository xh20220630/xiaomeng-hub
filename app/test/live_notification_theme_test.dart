import 'dart:io';
import 'dart:ui' as ui;

import 'package:claude_monitor/screens/live_notification_theme_screen.dart';
import 'package:claude_monitor/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'theme states switch artwork and never show stale progress offline',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      const output = String.fromEnvironment('LIVE_THEME_REVIEW_DIR');
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
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(),
            home: const LiveNotificationThemeScreen(),
          ),
        ),
      );
      for (final status in LiveThemeStatus.values) {
        await tester.tap(find.widgetWithText(ChoiceChip, status.label));
        await tester.pumpAndSettle();
        await tester.runAsync(() async {
          await precacheImage(
            AssetImage(status.assetPath),
            tester.element(find.byType(LiveThemePreviewCard)),
          );
          await precacheImage(
            const AssetImage('assets/ui-v3/mascot-avatar.png'),
            tester.element(find.byType(LiveThemePreviewCard)),
          );
        });
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pumpAndSettle();
        expect(find.text(status.detail), findsOneWidget);
        expect(
          find.text('3 / 5'),
          status == LiveThemeStatus.running ? findsOneWidget : findsNothing,
        );
        expect(tester.takeException(), isNull);
        if (output.isNotEmpty) {
          await tester.runAsync(() async {
            final render =
                boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final image = await render.toImage(pixelRatio: 2);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File(
              '$output/${status.name}.png',
            ).writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
      }
      tester.view.physicalSize = const Size(320, 640);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: const TextScaler.linear(1.4)),
            child: child!,
          ),
          home: const LiveNotificationThemeScreen(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView), const Offset(0, -700));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'system preview uses isolated sample channel, handles denied permission',
    (tester) async {
      final calls = <MethodCall>[];
      const channel = MethodChannel('claude/liveupdate');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            return false;
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: const LiveNotificationThemeScreen(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(find.text('发送系统预览通知'), 200);
      await tester.tap(find.text('发送系统预览通知'));
      await tester.pumpAndSettle();
      expect(calls.single.method, 'previewTheme');
      expect(calls.single.arguments, {'status': 'running'});
      expect(find.text('无法显示预览，请检查系统通知权限'), findsOneWidget);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );
}
