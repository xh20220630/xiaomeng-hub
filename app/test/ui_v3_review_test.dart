import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:claude_monitor/models.dart';
import 'package:claude_monitor/screens/home_screen.dart';
import 'package:claude_monitor/screens/agents_screen.dart';
import 'package:claude_monitor/screens/settings_screen.dart';
import 'package:claude_monitor/screens/project_detail_screen.dart';
import 'package:claude_monitor/services/api_service.dart';
import 'package:claude_monitor/services/ws_service.dart';
import 'package:claude_monitor/state/monitor.dart';
import 'package:claude_monitor/state/history.dart';
import 'package:claude_monitor/state/settings.dart';
import 'package:claude_monitor/theme/app_theme.dart';

const _output = String.fromEnvironment('UI_REVIEW_DIR');
const _capabilities = [
  'message.send',
  'message.steer',
  'session.start',
  'session.stop',
  'approval.respond',
  'agent.catalog',
  'session.configure',
];
const _approval = Approval(
  approvalId: 'approval',
  sessionId: 'pending',
  projectId: 'brand',
  kind: 'command',
  title: '运行项目检查',
  command: 'flutter analyze',
  createdAt: 0,
);
const _projects = {
  'studio': Project(
    projectId: 'studio',
    name: '小梦工作室',
    cwd: 'workspace / xiaomeng',
    status: 'done',
    activeSessionId: 'creative',
    agentId: 'claude',
    agentName: 'Claude Code',
    nodeName: '工作站',
    capabilities: _capabilities,
    sessionCount: 3,
    sessions: [
      Session(
        sessionId: 'creative',
        status: 'done',
        summary: '打磨你的下一个好想法',
        model: 'Claude Sonnet',
      ),
      Session(
        sessionId: 'next',
        status: 'running',
        summary: '让灵感，自由生长',
        model: 'Claude Sonnet',
      ),
      Session(
        sessionId: 'archived',
        status: 'done',
        summary: '那些值得珍藏的灵感',
        archived: true,
      ),
    ],
  ),
  'brand': Project(
    projectId: 'brand',
    name: '品牌官网',
    cwd: 'studio / website',
    status: 'needs_approval',
    agentId: 'codex',
    agentName: 'Codex',
    nodeName: '工作站',
    activeSessionId: 'pending',
    sessionCount: 1,
    capabilities: _capabilities,
    sessions: [
      Session(
        sessionId: 'pending',
        status: 'needs_approval',
        summary: '为品牌建立新的视觉语言',
        model: 'Codex',
      ),
    ],
  ),
};

class _ReviewMonitor extends MonitorNotifier {
  final bool empty;
  _ReviewMonitor({this.empty = false});
  @override
  MonitorState build() => empty
      ? const MonitorState(status: WsStatus.disconnected)
      : const MonitorState(
          status: WsStatus.connected,
          serverProjects: _projects,
          approvals: {'approval': _approval},
          agents: {
            'claude': AgentInfo(
              agentId: 'claude',
              name: 'Claude Code',
              provider: 'Anthropic',
              nodeId: 'pc',
              nodeName: '我的工作站',
              online: true,
              capabilities: _capabilities,
            ),
            'codex': AgentInfo(
              agentId: 'codex',
              name: 'Codex',
              provider: 'OpenAI',
              nodeId: 'pc',
              nodeName: '我的工作站',
              online: true,
              capabilities: _capabilities,
            ),
          },
        );
}

class _ReviewHistory extends HistoryController {
  _ReviewHistory(super.sessionId);
  @override
  ConversationHistory build() => ConversationHistory(
    events: [
      TaskEvent(
        id: 2,
        sessionId: sessionId,
        hookEventName: 'AssistantText',
        status: 'done',
        detail: '我会先梳理页面结构，再让视觉更轻盈。\n\n新的页面会使用更克制的留白，让重要操作一眼可见。',
        createdAt: DateTime(2026, 9, 17, 21, 33).millisecondsSinceEpoch,
      ),
      TaskEvent(
        id: 1,
        sessionId: sessionId,
        hookEventName: 'UserPromptSubmit',
        status: 'done',
        detail: '请帮我把首页做得更有呼吸感，保留清晰的信息层级。',
        createdAt: DateTime(2026, 9, 17, 21, 32).millisecondsSinceEpoch,
      ),
    ],
  );
  @override
  Future<void> refresh() async {}
}

class _ReviewApi extends ApiService {
  _ReviewApi() : super('http://localhost');
  @override
  Future<Map<String, dynamic>> agentCatalog(
    String agentId,
    String sessionId,
  ) async => {
    'models': [
      {
        'id': 'Claude Sonnet',
        'name': 'Claude Sonnet',
        'reasoningEfforts': ['low', 'medium', 'high'],
      },
      {'id': 'Claude Opus', 'name': 'Claude Opus'},
    ],
    'modes': [
      {'id': 'default', 'name': '默认'},
      {'id': 'plan', 'name': '计划'},
    ],
  };
}

void main() {
  testWidgets(
    'review every redesigned page and narrow layout with real assets',
    (tester) async {
      SharedPreferences.setMockInitialValues({
        'host': '192.168.0.194',
        'port': 4820,
      });
      late SharedPreferences prefs;
      await tester.runAsync(() async {
        prefs = await SharedPreferences.getInstance();
        final icons = FontLoader('MaterialIcons')
          ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
        await icons.load();
        final font = File(
          Platform.isWindows
              ? r'C:\Windows\Fonts\msyh.ttc'
              : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        );
        if (await font.exists()) {
          final data = ByteData.sublistView(await font.readAsBytes());
          for (final family in [
            'Microsoft YaHei',
            'Noto Sans SC',
            'Roboto',
            'monospace',
          ]) {
            final loader = FontLoader(family)..addFont(Future.value(data));
            await loader.load();
          }
        }
      });
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final boundary = GlobalKey();

      Future<void> mount(Widget page, {bool empty = false}) async {
        await tester.pumpWidget(const SizedBox());
        await tester.pump();
        await tester.pumpWidget(
          ProviderScope(
            key: UniqueKey(),
            overrides: [
              sharedPrefsProvider.overrideWithValue(prefs),
              monitorProvider.overrideWith(() => _ReviewMonitor(empty: empty)),
              historyProvider.overrideWith2(_ReviewHistory.new),
              apiServiceProvider.overrideWithValue(_ReviewApi()),
            ],
            child: RepaintBoundary(
              key: boundary,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: buildAppTheme(),
                home: page,
              ),
            ),
          ),
        );
        await tester.runAsync(() async {
          final context = tester.element(find.byType(Scaffold).first);
          await precacheImage(
            const AssetImage('assets/motion/ip-tabbar-still.png'),
            context,
          );
          for (final file
              in Directory('assets/ui-v3').listSync().whereType<File>().where(
                (file) => file.path.endsWith('.png'),
              )) {
            await precacheImage(
              AssetImage(file.path.replaceAll('\\', '/')),
              context,
            );
          }
        });
        await tester.pumpAndSettle();
        await tester.runAsync(() async {
          final context = tester.element(find.byType(Scaffold).first);
          for (final image
              in tester.widgetList<Image>(find.byType(Image)).toList()) {
            await precacheImage(image.image, context);
          }
        });
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      }

      Future<void> capture(String name) async {
        await tester.pumpAndSettle();
        await tester.runAsync(() async {
          final context = tester.element(find.byType(Scaffold).first);
          for (final image
              in tester.widgetList<Image>(find.byType(Image)).toList()) {
            await precacheImage(image.image, context);
          }
        });
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        if (_output.isEmpty) return;
        await tester.runAsync(() async {
          final render =
              boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await render.toImage(pixelRatio: 2);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(_output).create(recursive: true);
          await File(
            '$_output/$name.png',
          ).writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }

      await mount(const HomeScreen());
      await capture('01-conversations');
      for (final entry in [
        ('项目', '02-projects'),
        ('收件箱', '03-inbox'),
        ('归档', '04-archive'),
      ]) {
        await tester.tap(find.text(entry.$1).last);
        await tester.pumpAndSettle();
        await capture(entry.$2);
      }
      await mount(const AgentsScreen());
      await capture('05-agents');
      await mount(const SettingsScreen());
      await capture('06-settings');
      await tester.tap(find.byTooltip('显示令牌'));
      await tester.pump();
      expect(
        tester.widget<TextField>(find.byType(TextField).last).obscureText,
        isFalse,
      );
      await mount(
        const ProjectDetailScreen(projectId: 'studio', sessionId: 'creative'),
      );
      await capture('07-conversation-detail');
      await mount(const HomeScreen());
      await tester.tap(find.text('开启新会话'));
      await capture('08-new-conversation');
      await mount(
        const ProjectDetailScreen(projectId: 'studio', sessionId: 'creative'),
      );
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await capture('09-agent-settings');
      await mount(const HomeScreen());
      await tester.tap(find.text('收件箱').last);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('查看并处理请求'));
      await tester.tap(find.text('查看并处理请求'));
      await tester.pumpAndSettle();
      expect(find.text('小梦需要你批准'), findsOneWidget);
      await capture('10-approval');
      await mount(const HomeScreen());
      await tester.tap(find.byTooltip('打开导航'));
      await capture('13-navigation');
      await mount(
        const ProjectDetailScreen(projectId: 'studio', sessionId: 'creative'),
      );
      await tester.tap(find.text('打磨你的下一个好想法'));
      await capture('14-session-picker');
      await mount(const HomeScreen(), empty: true);
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -260));
      await capture('15-offline-empty');
      tester.view.physicalSize = const Size(1440, 1000);
      await mount(const HomeScreen());
      await capture('11-desktop');
      await tester.ensureVisible(find.text('打磨你的下一个好想法'));
      await tester.tap(find.text('打磨你的下一个好想法'));
      await capture('12-desktop-conversation');
      await tester.tap(find.text('项目').first);
      await capture('16-desktop-projects');
      tester.view.physicalSize = const Size(320, 700);
      tester.platformDispatcher.textScaleFactorTestValue = 1.4;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      for (final page in [
        const HomeScreen(),
        const AgentsScreen(),
        const SettingsScreen(),
        const ProjectDetailScreen(projectId: 'studio', sessionId: 'creative'),
      ]) {
        await mount(page);
        expect(tester.takeException(), isNull);
      }
      await mount(const HomeScreen());
      for (final label in ['项目', '收件箱', '归档']) {
        await tester.tap(find.text(label).last);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        if (label == '项目') await capture('17-narrow-projects');
      }
      await tester.tap(find.byTooltip('打开导航'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('连接设置'));
      expect(find.text('连接设置').hitTestable(), findsOneWidget);
      await capture('18-narrow-navigation');
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
    skip: !const bool.fromEnvironment('STATIC_CAPTURE'),
  );
}
