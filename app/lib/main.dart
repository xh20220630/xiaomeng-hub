import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'state/settings.dart';
import 'state/monitor.dart';
import 'screens/home_screen.dart';
import 'screens/project_detail_screen.dart';
import 'services/live_update.dart';
import 'theme/app_theme.dart';
import 'widgets/approval_drawer.dart';

final navigatorKey = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  runApp(
    ProviderScope(
      overrides: [sharedPrefsProvider.overrideWithValue(prefs)],
      child: const ClaudeMonitorApp(),
    ),
  );
}

class ClaudeMonitorApp extends ConsumerStatefulWidget {
  const ClaudeMonitorApp({super.key});

  @override
  ConsumerState<ClaudeMonitorApp> createState() => _ClaudeMonitorAppState();
}

class _ClaudeMonitorAppState extends ConsumerState<ClaudeMonitorApp> {
  @override
  void initState() {
    super.initState();
    // Native notification taps while the app is alive (onDeeplink push).
    LiveUpdate.setDeeplinkHandler(_handleDeeplink);
    // Cold start from a notification tap: MainActivity extras -> deeplink.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final d = await LiveUpdate.getLaunchDeeplink();
      if (d != null) _handleDeeplink(d);
    });
  }

  void _handleDeeplink(Map<String, String?> data) {
    final projectId = data['projectId'];
    final sessionId = data['sessionId'];
    final approvalId = data['approvalId'];
    if (projectId != null && projectId.isNotEmpty) {
      navigatorKey.currentState?.push(
        MaterialPageRoute(
          builder: (_) => ProjectDetailScreen(
            projectId: projectId,
            sessionId: (sessionId != null && sessionId.isNotEmpty)
                ? sessionId
                : null,
          ),
        ),
      );
    }
    if (approvalId != null && approvalId.isNotEmpty) {
      _openApprovalWhenReady(approvalId);
    }
  }

  /// The approval may not be loaded yet on a cold start — poll the monitor
  /// state briefly, then open the drawer if it is still pending.
  Future<void> _openApprovalWhenReady(String approvalId) async {
    for (var i = 0; i < 20; i++) {
      final ap = ref.read(monitorProvider).approvals[approvalId];
      if (ap != null) {
        if (!ap.isPending) return; // already handled/expired elsewhere
        final ctx = navigatorKey.currentContext;
        if (ctx != null && ctx.mounted) showApprovalDrawer(ctx, ref, ap);
        return;
      }
      await Future.delayed(const Duration(milliseconds: 300));
      if (!mounted) return;
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<String?>(monitorProvider.select((s) => s.commandError), (
      previous,
      next,
    ) {
      if (next == null) return;
      final context = navigatorKey.currentContext;
      if (context != null) {
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(SnackBar(content: Text(next)));
      }
      Future.microtask(
        () => ref.read(monitorProvider.notifier).clearCommandError(),
      );
    });
    // Keep the monitor (WebSocket) alive for the whole app lifetime.
    ref.watch(monitorProvider.select((state) => state.status));
    // Construct the notification service now so it initialises and asks for the
    // Android 13+ POST_NOTIFICATIONS permission up front (the native foreground
    // service needs it too — Dart itself no longer posts on Android).
    ref.watch(notificationServiceProvider);

    return MaterialApp(
      title: '小梦 · 夜航工作室',
      debugShowCheckedModeBanner: false,
      navigatorKey: navigatorKey,
      theme: buildAppTheme(),
      home: const HomeScreen(),
    );
  }
}
