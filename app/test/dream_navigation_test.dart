import 'package:claude_monitor/theme/tokens.dart';
import 'package:claude_monitor/widgets/dream_navigation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> mountNavigation(
  WidgetTester tester, {
  bool reduced = false,
  double scale = 1,
  ValueChanged<int>? onSelected,
}) async {
  var selected = 0;
  await tester.pumpWidget(
    MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(
          disableAnimations: reduced,
          textScaler: TextScaler.linear(scale),
        ),
        child: Scaffold(
          bottomNavigationBar: StatefulBuilder(
            builder: (context, setState) => DreamNavigation(
              selectedIndex: selected,
              pending: 3,
              onSelected: (value) {
                setState(() => selected = value);
                onSelected?.call(value);
              },
            ),
          ),
        ),
      ),
    ),
  );
  await tester.runAsync(
    () => precacheImage(
      AssetImage(
        'assets/motion/${reduced || kStaticCapture ? 'tabbar-still' : 'tabbar-atlas'}.png',
      ),
      tester.element(find.byType(DreamNavigation)),
    ),
  );
  await tester.pumpAndSettle();
}

NavigationSpritePainter sprite(WidgetTester tester, int index) => tester
    .widgetList<CustomPaint>(find.byType(CustomPaint))
    .map((widget) => widget.painter)
    .whereType<NavigationSpritePainter>()
    .singleWhere((painter) => painter.index == index);

Finder tab(int index) => find.byKey(ValueKey('dream-tab-$index'));

void main() {
  testWidgets(
    'selected icons hold their final pose until another tab is selected',
    (tester) async {
      final selections = <int>[];
      await mountNavigation(tester, onSelected: selections.add);
      expect(sprite(tester, 0).image.width, 1024);
      expect(sprite(tester, 0).image.height, 1024);
      expect(sprite(tester, 0).frame, 15);
      expect(sprite(tester, 1).frame, 0);
      await tester.tap(tab(1));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 180));
      expect(selections, [1]);
      expect(sprite(tester, 1).frame, greaterThan(0));
      expect(sprite(tester, 0).frame, lessThan(15));
      expect(
        tester
            .widget<DreamNavigation>(find.byType(DreamNavigation))
            .selectedIndex,
        1,
      );
      await tester.pumpAndSettle();
      expect(sprite(tester, 1).frame, 15);
      expect(sprite(tester, 0).frame, 0);
      await tester.pump(const Duration(seconds: 2));
      expect(sprite(tester, 1).frame, 15);
      expect(tester.binding.transientCallbackCount, 0);
    },
    skip: kStaticCapture,
  );

  testWidgets(
    'rapid switching reverses from the current pose and selected taps do not reset it',
    (tester) async {
      await mountNavigation(tester);
      await tester.tap(tab(1));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 180));
      final halfway = sprite(tester, 1).frame;
      await tester.tap(tab(3));
      await tester.pump();
      expect(sprite(tester, 1).frame, halfway);
      await tester.pump(const Duration(milliseconds: 60));
      expect(sprite(tester, 1).frame, lessThan(halfway));
      expect(sprite(tester, 3).frame, greaterThan(0));
      await tester.pumpAndSettle();
      expect(sprite(tester, 1).frame, 0);
      expect(sprite(tester, 3).frame, 15);
      await tester.tap(tab(3));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 180));
      expect(sprite(tester, 3).frame, 15);
      await tester.pumpWidget(const SizedBox());
      expect(tester.takeException(), isNull);
      expect(tester.binding.transientCallbackCount, 0);
    },
    skip: kStaticCapture,
  );

  testWidgets(
    'small screens and larger type retain all targets and pending badge',
    (tester) async {
      tester.view.physicalSize = const Size(320, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await mountNavigation(tester, reduced: true, scale: 1.4);
      expect(sprite(tester, 0).image.width, 512);
      expect(sprite(tester, 0).image.height, 256);
      for (var i = 0; i < 4; i++) {
        expect(tester.getSize(tab(i)).width, greaterThanOrEqualTo(48));
        expect(tester.getSize(tab(i)).height, greaterThanOrEqualTo(48));
        await tester.tap(tab(i));
        await tester.pumpAndSettle();
        expect(sprite(tester, i).animated, isFalse);
        expect(sprite(tester, i).frame, 15);
        expect(sprite(tester, (i + 1) % 4).frame, 0);
        expect(tester.takeException(), isNull);
      }
      expect(find.text('3'), findsOneWidget);
      expect(find.text('收件箱'), findsOneWidget);
      expect(tester.binding.transientCallbackCount, 0);
    },
  );
}
