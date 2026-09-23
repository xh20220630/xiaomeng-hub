import 'package:claude_monitor/theme/tokens.dart';
import 'package:claude_monitor/widgets/dream_motion.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host(
  Widget child, {
  bool disableAnimations = false,
  bool tickerEnabled = true,
}) => MediaQuery(
  data: MediaQueryData(disableAnimations: disableAnimations),
  child: Directionality(
    textDirection: TextDirection.ltr,
    child: TickerMode(
      enabled: tickerEnabled,
      child: Material(child: Center(child: child)),
    ),
  ),
);

Widget _loopingContent({bool active = true}) => Column(
  mainAxisSize: MainAxisSize.min,
  children: [
    DreamFloat(
      active: active,
      child: const SizedBox(
        key: ValueKey('floating-child'),
        width: 30,
        height: 30,
      ),
    ),
    DreamActivityDot(active: active),
    SizedBox(
      width: 120,
      height: 120,
      child: DreamOrbitHero(
        active: active,
        child: const SizedBox(width: 50, height: 50),
      ),
    ),
  ],
);

double _pressScale(WidgetTester tester) => tester
    .widget<AnimatedScale>(
      find.descendant(
        of: find.byType(DreamPress),
        matching: find.byType(AnimatedScale),
      ),
    )
    .scale;

void main() {
  testWidgets('press feedback preserves child button taps', (tester) async {
    var taps = 0;
    await tester.pumpWidget(
      _host(
        DreamPress(
          child: FilledButton(
            onPressed: () => taps++,
            child: const Text('Start'),
          ),
        ),
      ),
    );

    final gesture = await tester.startGesture(
      tester.getCenter(find.text('Start')),
    );
    await tester.pump(const Duration(milliseconds: 120));
    expect(_pressScale(tester), kStaticCapture ? 1 : .97);
    await gesture.up();
    await tester.pumpAndSettle();

    expect(taps, 1);
    expect(_pressScale(tester), 1);
  });

  testWidgets('pointer cancellation releases feedback without tapping', (
    tester,
  ) async {
    var taps = 0;
    await tester.pumpWidget(
      _host(
        DreamPress(
          child: FilledButton(
            onPressed: () => taps++,
            child: const Text('Start'),
          ),
        ),
      ),
    );

    final gesture = await tester.startGesture(
      tester.getCenter(find.text('Start')),
    );
    await tester.pump(const Duration(milliseconds: 120));
    await gesture.cancel();
    await tester.pumpAndSettle();

    expect(taps, 0);
    expect(_pressScale(tester), 1);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets('press wrapper preserves scrolling and releases after drag', (
    tester,
  ) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    var taps = 0;
    await tester.pumpWidget(
      _host(
        DreamPress(
          child: SizedBox(
            width: 240,
            height: 240,
            child: ListView(
              controller: controller,
              children: [
                for (var i = 0; i < 20; i++)
                  SizedBox(
                    height: 80,
                    child: TextButton(
                      onPressed: () => taps++,
                      child: Text('Item $i'),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );

    await tester.drag(find.text('Item 1'), const Offset(0, -140));
    await tester.pumpAndSettle();

    expect(controller.offset, greaterThan(0));
    expect(taps, 0);
    expect(_pressScale(tester), 1);
  });

  testWidgets('reduced motion settles all decorative loops immediately', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        DreamReveal(
          delay: const Duration(seconds: 10),
          child: _loopingContent(),
        ),
        disableAnimations: true,
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.binding.transientCallbackCount, 0);
    expect(tester.binding.hasScheduledFrame, isFalse);
    expect(
      tester
          .widget<Opacity>(
            find.descendant(
              of: find.byType(DreamReveal),
              matching: find.byType(Opacity),
            ),
          )
          .opacity,
      1,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('loops obey STATIC_CAPTURE and stop when inactive', (
    tester,
  ) async {
    await tester.pumpWidget(_host(_loopingContent()));
    await tester.pump(const Duration(milliseconds: 120));

    expect(
      tester.binding.transientCallbackCount,
      kStaticCapture ? 0 : greaterThan(0),
    );

    await tester.pumpWidget(_host(_loopingContent(active: false)));
    await tester.pumpAndSettle();

    expect(tester.binding.transientCallbackCount, 0);
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('TickerMode and changing reduced motion stop existing loops', (
    tester,
  ) async {
    await tester.pumpWidget(_host(_loopingContent()));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpWidget(_host(_loopingContent(), tickerEnabled: false));
    await tester.pumpAndSettle();
    expect(tester.binding.transientCallbackCount, 0);

    await tester.pumpWidget(_host(_loopingContent()));
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      tester.binding.transientCallbackCount,
      kStaticCapture ? 0 : greaterThan(0),
    );

    await tester.pumpWidget(_host(_loopingContent(), disableAnimations: true));
    await tester.pumpAndSettle();
    expect(tester.binding.transientCallbackCount, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unmounting a pending reveal cancels its timer', (tester) async {
    await tester.pumpWidget(
      _host(
        const DreamReveal(
          delay: Duration(seconds: 2),
          child: Text('Delayed content'),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pumpWidget(_host(const Text('Replacement')));
    await tester.pump(const Duration(seconds: 3));

    expect(find.text('Replacement'), findsOneWidget);
    expect(find.text('Delayed content'), findsNothing);
    expect(tester.takeException(), isNull);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets('status switching keeps the new child interactive', (
    tester,
  ) async {
    var oldTaps = 0;
    var newTaps = 0;
    Widget status(bool completed) => _host(
      DreamStatusSwitcher(
        child: TextButton(
          key: ValueKey(completed),
          onPressed: completed ? () => newTaps++ : () => oldTaps++,
          child: Text(completed ? 'Completed' : 'Running'),
        ),
      ),
    );

    await tester.pumpWidget(status(false));
    await tester.pumpWidget(status(true));
    await tester.pump(const Duration(milliseconds: 60));
    await tester.tap(find.text('Completed'));
    await tester.pumpAndSettle();

    expect(oldTaps, 0);
    expect(newTaps, 1);
    expect(find.text('Running'), findsNothing);
    expect(find.text('Completed'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('reduced-motion status replacement has no outgoing child', (
    tester,
  ) async {
    Widget status(String value) => _host(
      DreamStatusSwitcher(child: Text(value, key: ValueKey(value))),
      disableAnimations: true,
    );

    await tester.pumpWidget(status('Running'));
    await tester.pumpWidget(status('Completed'));

    expect(find.text('Running'), findsNothing);
    expect(find.text('Completed'), findsOneWidget);
    expect(tester.binding.transientCallbackCount, 0);
  });
}
