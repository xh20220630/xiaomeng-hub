import 'package:flutter/widgets.dart';

class HostResourceScope extends InheritedWidget {
  final String sessionId;
  final String? baseResourceId;
  const HostResourceScope({
    super.key,
    required this.sessionId,
    this.baseResourceId,
    required super.child,
  });
  static HostResourceScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<HostResourceScope>();
  @override
  bool updateShouldNotify(HostResourceScope oldWidget) =>
      sessionId != oldWidget.sessionId ||
      baseResourceId != oldWidget.baseResourceId;
}
