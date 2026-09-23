import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:claude_monitor/widgets/status_chip.dart';

void main() {
  testWidgets('StatusChip renders the Chinese label for a status', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: StatusChip('needs_approval'))),
    );
    expect(find.text('需审批'), findsOneWidget);
  });
}
