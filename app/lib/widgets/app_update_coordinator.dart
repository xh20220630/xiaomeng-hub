import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_updates.dart';
import '../theme/tokens.dart';

class AppUpdateCoordinator extends ConsumerStatefulWidget {
  final Widget child;
  final VoidCallback onOpen;
  const AppUpdateCoordinator({
    super.key,
    required this.child,
    required this.onOpen,
  });

  @override
  ConsumerState<AppUpdateCoordinator> createState() =>
      _AppUpdateCoordinatorState();
}

class _AppUpdateCoordinatorState extends ConsumerState<AppUpdateCoordinator>
    with WidgetsBindingObserver {
  Timer? _timer;
  String? _dismissed;
  late final AppUpdates _updates;

  @override
  void initState() {
    super.initState();
    _updates = ref.read(appUpdatesProvider);
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _updates.checkAutomatic();
    });
    _timer = Timer.periodic(
      const Duration(minutes: 5),
      (_) => _updates.checkAutomatic(),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _updates.foreground(state == AppLifecycleState.resumed);
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _updates,
    builder: (context, _) {
      final release = _updates.available;
      final noticeKey = '${release?.sha256}/${_updates.ready}';
      return Column(
        children: [
          Expanded(child: widget.child),
          if (release != null && _dismissed != noticeKey)
            Material(
              color: AppColors.greenLight,
              child: SafeArea(
                top: false,
                child: Row(
                  children: [
                    const SizedBox(width: 16),
                    const Icon(Icons.system_update_rounded),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        _updates.ready
                            ? '新版本 ${release.version.name} 已就绪'
                            : '发现新版本 ${release.version.name}',
                      ),
                    ),
                    TextButton(
                      onPressed: widget.onOpen,
                      child: Text(_updates.ready ? '去安装' : '查看'),
                    ),
                    Semantics(
                      label: '稍后提醒',
                      child: IconButton(
                        key: const Key('dismiss-update'),
                        onPressed: () => setState(() => _dismissed = noticeKey),
                        icon: const Icon(Icons.close_rounded, size: 18),
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      );
    },
  );
}
