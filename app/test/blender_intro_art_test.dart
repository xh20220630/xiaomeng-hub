import 'package:claude_monitor/theme/tokens.dart';
import 'package:claude_monitor/widgets/blender_intro_art.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(
  BlenderIntroScene scene, {
  bool active = true,
  bool reduced = false,
}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(disableAnimations: reduced),
    child: Scaffold(
      body: Center(
        child: BlenderIntroArt(scene: scene, active: active),
      ),
    ),
  ),
);

Future<void> loadScene(WidgetTester tester, BlenderIntroScene scene) async {
  await tester.pumpWidget(host(scene));
  await tester.runAsync(
    () => precacheImage(
      AssetImage('assets/motion/${scene.name}-intro-atlas.png'),
      tester.element(find.byType(BlenderIntroArt)),
    ),
  );
  await tester.pump();
}

IntroFramePainter frame(WidgetTester tester) => tester
    .widgetList<CustomPaint>(find.byType(CustomPaint))
    .map((widget) => widget.painter)
    .whereType<IntroFramePainter>()
    .single;

void main() {
  testWidgets(
    'all three card scenes load and switch without stale textures',
    (tester) async {
      Object? previous;
      for (final scene in BlenderIntroScene.values) {
        await loadScene(tester, scene);
        final first = frame(tester);
        expect(first.image.width, 2048);
        expect(first.image.height, 1536);
        expect(first.frame, 0);
        expect(identical(first.image, previous), isFalse);
        previous = first.image;
        await tester.pump(const Duration(milliseconds: 500));
        expect(frame(tester).frame, 6);
        await tester.pump(const Duration(milliseconds: 3500));
        expect(frame(tester).frame, 0);
      }
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
      expect(tester.binding.transientCallbackCount, 0);
    },
    skip: kStaticCapture,
  );

  testWidgets('offscreen and background scenes pause and resume', (
    tester,
  ) async {
    await loadScene(tester, BlenderIntroScene.project);
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpWidget(host(BlenderIntroScene.project, active: false));
    final pausedFrame = frame(tester).frame;
    await tester.pumpAndSettle();
    expect(tester.binding.transientCallbackCount, 0);
    expect(frame(tester).frame, pausedFrame);
    await tester.pumpWidget(host(BlenderIntroScene.project));
    await tester.pump(const Duration(milliseconds: 500));
    expect(frame(tester).frame, isNot(pausedFrame));
    final observer =
        tester.state(find.byType(BlenderIntroArt)) as WidgetsBindingObserver;
    observer.didChangeAppLifecycleState(AppLifecycleState.paused);
    await tester.pumpAndSettle();
    expect(tester.binding.transientCallbackCount, 0);
    observer.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await tester.pump();
    expect(tester.binding.transientCallbackCount, greaterThan(0));
    await tester.pumpWidget(const SizedBox());
    expect(tester.takeException(), isNull);
  }, skip: kStaticCapture);

  testWidgets('reduced motion uses the correct still for every page', (
    tester,
  ) async {
    for (final scene in BlenderIntroScene.values) {
      await tester.pumpWidget(host(scene, reduced: true));
      await tester.runAsync(
        () => precacheImage(
          AssetImage('assets/motion/${scene.name}-intro-still.png'),
          tester.element(find.byType(BlenderIntroArt)),
        ),
      );
      await tester.pumpAndSettle();
      final image = tester.widget<Image>(find.byType(Image));
      expect(
        (image.image as AssetImage).assetName,
        'assets/motion/${scene.name}-intro-still.png',
      );
      expect(tester.binding.transientCallbackCount, 0);
      expect(tester.takeException(), isNull);
    }
  });
}
