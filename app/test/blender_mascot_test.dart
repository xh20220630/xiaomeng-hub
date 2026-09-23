import 'package:claude_monitor/widgets/blender_mascot.dart';
import 'package:claude_monitor/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host({bool reducedMotion = false, bool visible = true}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(disableAnimations: reducedMotion),
    child: TickerMode(
      enabled: visible,
      child: const Scaffold(body: Center(child: BlenderMascot(size: 200))),
    ),
  ),
);

Future<void> loadAnimation(WidgetTester tester) async {
  await tester.pumpWidget(host());
  await tester.runAsync(() async {
    await precacheImage(
      const AssetImage('assets/motion/night-orbit-atlas.png'),
      tester.element(find.byType(BlenderMascot)),
    );
  });
  await tester.pump();
}

BlenderFramePainter currentFrame(WidgetTester tester) => tester
    .widgetList<CustomPaint>(find.byType(CustomPaint))
    .map((widget) => widget.painter)
    .whereType<BlenderFramePainter>()
    .single;

void main() {
  testWidgets(
    'Blender atlas advances and wraps over a four second loop',
    (tester) async {
      await loadAnimation(tester);
      final first = currentFrame(tester);
      expect(first.image.width, 3072);
      expect(first.image.height, 2304);
      await tester.pump(const Duration(milliseconds: 500));
      expect(currentFrame(tester).frame, 6);
      await tester.pump(const Duration(milliseconds: 3500));
      expect(currentFrame(tester).frame, 0);
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
    },
    skip: kStaticCapture,
  );

  testWidgets(
    'leaving the viewport stops animation and returning resumes it',
    (tester) async {
      await loadAnimation(tester);
      await tester.pumpWidget(host(visible: false));
      await tester.pumpAndSettle();
      expect(tester.binding.transientCallbackCount, 0);
      await tester.pumpWidget(host());
      await tester.pump(const Duration(milliseconds: 500));
      expect(currentFrame(tester).frame, greaterThan(0));
      await tester.pumpWidget(const SizedBox());
    },
    skip: kStaticCapture,
  );

  testWidgets('reduced motion keeps a still and does not animate on tap', (
    tester,
  ) async {
    await tester.pumpWidget(host(reducedMotion: true));
    await tester.tap(find.byType(TextButton));
    await tester.pumpAndSettle();
    expect(
      tester
          .widgetList<CustomPaint>(find.byType(CustomPaint))
          .map((widget) => widget.painter)
          .whereType<BlenderFramePainter>(),
      isEmpty,
    );
    expect(tester.binding.transientCallbackCount, 0);
    expect(find.byTooltip('和小梦打个招呼'), findsOneWidget);
  });

  testWidgets(
    'backgrounding pauses the loop and repeated taps dispose cleanly',
    (tester) async {
      await loadAnimation(tester);
      await tester.tap(find.byType(TextButton));
      await tester.pump(const Duration(milliseconds: 180));
      await tester.tap(find.byType(TextButton));
      await tester.pump(const Duration(milliseconds: 180));
      final observer =
          tester.state(find.byType(BlenderMascot)) as WidgetsBindingObserver;
      observer.didChangeAppLifecycleState(AppLifecycleState.paused);
      await tester.pumpAndSettle();
      expect(tester.binding.transientCallbackCount, 0);
      observer.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(tester.binding.transientCallbackCount, greaterThan(0));
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
      expect(tester.binding.transientCallbackCount, 0);
    },
    skip: kStaticCapture,
  );
}
