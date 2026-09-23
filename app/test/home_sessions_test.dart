import 'dart:convert';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:claude_monitor/models.dart';
import 'package:claude_monitor/screens/home_screen.dart';
import 'package:claude_monitor/screens/project_detail_screen.dart';
import 'package:claude_monitor/services/ws_service.dart';
import 'package:claude_monitor/services/api_service.dart';
import 'package:claude_monitor/state/monitor.dart';
import 'package:claude_monitor/state/history.dart';
import 'package:claude_monitor/widgets/chat_widgets.dart';
import 'package:claude_monitor/widgets/approval_drawer.dart';

class _ModelApi extends ApiService {
  _ModelApi() : super('http://localhost');
  final confirmation = Completer<Map<String, dynamic>>();
  Map<String, String>? settings;
  @override
  Future<Map<String, dynamic>> agentCatalog(
    String agentId,
    String sessionId,
  ) async => {
    'models': [
      {'id': 'model-a', 'name': 'Model A'},
      {'id': 'model-b', 'name': 'Model B'},
    ],
  };
  @override
  Future<Map<String, dynamic>> configureSession(
    String sessionId,
    Map<String, String> settings,
  ) {
    this.settings = settings;
    return confirmation.future;
  }
}

class _FakeHistory extends HistoryController {
  _FakeHistory(super.sessionId, this.events);
  final List<TaskEvent> events;
  @override
  ConversationHistory build() => ConversationHistory(events: events);
  @override
  Future<void> refresh() async {}
}

/// Returns a fixed MonitorState instead of opening a WebSocket.
class _FakeMonitor extends MonitorNotifier {
  final MonitorState _s;
  final void Function(String, String)? onSteer;
  final void Function(Map<String, String>?)? onAnswer;
  final void Function(String, String)? onControl;
  _FakeMonitor(this._s, {this.onSteer, this.onAnswer, this.onControl});
  @override
  MonitorState build() => _s;
  void update(MonitorState next) => state = next;
  @override
  void sessionControl(String sessionId, String action) =>
      onControl?.call(sessionId, action);
  @override
  bool steerMessage(String sessionId, String text) {
    onSteer?.call(sessionId, text);
    return true;
  }

  @override
  Future<bool> respondApproval(
    String approvalId, {
    required bool approve,
    String scope = 'once',
    Map<String, String>? answers,
  }) async {
    onAnswer?.call(answers);
    return true;
  }
}

/// Serves a valid (empty) asset manifest and a 1x1 transparent PNG for every
/// other asset, so mascot Image.asset() calls don't throw in the headless test
/// (assets aren't bundled by `flutter test`).
class _FakeAssetBundle extends CachingAssetBundle {
  static final Uint8List _png = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  );
  @override
  Future<ByteData> load(String key) async {
    if (key.contains('AssetManifest')) {
      return const StandardMessageCodec().encodeMessage(<String, Object>{})!;
    }
    return ByteData.view(_png.buffer);
  }

  @override
  Future<String> loadString(String key, {bool cache = true}) async =>
      key.contains('FontManifest') ? '[]' : '{}';
}

Project _ccProject() {
  final sessions = <Session>[
    const Session(
      sessionId: 's-active',
      status: 'running',
      summary: 'Build Claude task monitoring Flutter app',
      updatedAt: 3000,
    ),
    const Session(
      sessionId: 's-hello',
      status: 'done',
      summary: 'Hello test',
      updatedAt: 2000,
    ),
    const Session(
      sessionId: 's-mario',
      status: 'done',
      summary: 'Create super Mario game with high fidelity',
      updatedAt: 1000,
    ),
  ];
  return Project(
    projectId: 'D--cc-project',
    name: 'cc_project',
    cwd: r'D:\cc_project',
    status: 'running',
    activeSessionId: 's-active',
    summary: 'Build Claude task monitoring Flutter app',
    sessionCount: sessions.length,
    sessions: sessions,
    lastEventAt: 3000,
  );
}

Widget _host(MonitorState state) {
  return ProviderScope(
    overrides: [
      monitorProvider.overrideWith(() => _FakeMonitor(state)),
      // Keep F2 off the network if we navigate into it.
      historyProvider.overrideWith2((id) => _FakeHistory(id, const [])),
    ],
    child: DefaultAssetBundle(
      bundle: _FakeAssetBundle(),
      child: const MaterialApp(home: HomeScreen()),
    ),
  );
}

Future<void> _showSessions(WidgetTester tester) async {
  await tester.drag(find.byType(CustomScrollView), const Offset(0, -370));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  testWidgets('new conversation remains reachable above a phone keyboard', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpWidget(
      _host(
        const MonitorState(
          status: WsStatus.connected,
          serverProjects: {
            'p': Project(
              projectId: 'p',
              name: 'Demo',
              cwd: '/',
              status: 'done',
              online: true,
              capabilities: ['session.start'],
            ),
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('开启新会话'));
    await tester.pumpAndSettle();
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.text('发送并开始'));
    expect(find.text('发送并开始').hitTestable(), findsOneWidget);
  });

  testWidgets('narrow screens with larger text can browse and open a session', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.4;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(
      _host(
        MonitorState(
          status: WsStatus.connected,
          serverProjects: {'D--cc-project': _ccProject()},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.drag(find.byType(CustomScrollView), const Offset(0, -500));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Hello test'));
    await tester.tap(find.text('Hello test'));
    await tester.pumpAndSettle();
    expect(find.byType(ProjectDetailScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'the model picker lives inside the composer and preserves the draft after confirmation',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 760));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      const project = Project(
        projectId: 'p',
        name: 'P',
        cwd: '/',
        status: 'done',
        agentId: 'agent',
        activeSessionId: 's',
        capabilities: ['message.send', 'agent.catalog', 'session.configure'],
        sessions: [Session(sessionId: 's', status: 'done', model: 'model-a')],
      );
      final api = _ModelApi();
      final monitor = _FakeMonitor(
        const MonitorState(
          status: WsStatus.connected,
          serverProjects: {'p': project},
        ),
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiServiceProvider.overrideWithValue(api),
            monitorProvider.overrideWith(() => monitor),
            historyProvider.overrideWith2((id) => _FakeHistory(id, const [])),
          ],
          child: DefaultAssetBundle(
            bundle: _FakeAssetBundle(),
            child: const MaterialApp(home: ProjectDetailScreen(projectId: 'p')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byTooltip('模型与主机能力'), findsNothing);
      expect(find.text('model-a'), findsOneWidget);
      expect(
        tester
            .widget<IconButton>(find.byKey(const ValueKey('composer-action')))
            .onPressed,
        isNull,
      );
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('composer-model'))).dy,
        greaterThan(tester.getTopLeft(find.byType(TextField)).dy),
      );
      await tester.enterText(find.byType(TextField), '保留这条未发送的消息');
      await tester.pump();
      expect(
        tester
            .widget<IconButton>(find.byKey(const ValueKey('composer-action')))
            .onPressed,
        isNotNull,
      );
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Model A').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Model B').last);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('应用到此会话'));
      await tester.tap(find.text('应用到此会话'));
      await tester.pump();
      expect(api.settings, {'model': 'model-b'});
      expect(find.text('主机已确认，设置将在下一轮对话生效'), findsNothing);
      api.confirmation.complete({'confirmed': true});
      await tester.pumpAndSettle();
      expect(find.text('主机已确认，设置将在下一轮对话生效'), findsOneWidget);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      expect(find.text('model-b'), findsOneWidget);
      final updated = Project(
        projectId: 'p',
        name: 'P',
        cwd: '/',
        status: 'done',
        agentId: 'agent',
        activeSessionId: 's',
        capabilities: project.capabilities,
        sessions: const [
          Session(sessionId: 's', status: 'done', model: 'model-b'),
        ],
      );
      monitor.update(
        MonitorState(
          status: WsStatus.connected,
          serverProjects: {'p': updated},
        ),
      );
      await tester.pumpAndSettle();
      monitor.update(
        const MonitorState(
          status: WsStatus.connected,
          serverProjects: {'p': project},
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('model-a'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '保留这条未发送的消息',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Codex can steer while streaming without clearing the reply', (
    tester,
  ) async {
    String? submitted;
    String? controlled;
    const project = Project(
      projectId: 'codex',
      name: 'Codex 项目',
      cwd: '/repo',
      status: 'running',
      activeSessionId: 'turn',
      agentName: 'Codex',
      capabilities: ['message.send', 'message.steer', 'session.stop'],
      sessions: [
        Session(
          sessionId: 'turn',
          status: 'running',
          capabilities: ['message.send', 'message.steer', 'session.stop'],
        ),
      ],
    );
    const state = MonitorState(
      status: WsStatus.connected,
      serverProjects: {'codex': project},
      streaming: {'turn': '正在修改'},
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          monitorProvider.overrideWith(
            () => _FakeMonitor(
              state,
              onSteer: (id, text) => submitted = '$id:$text',
              onControl: (id, action) => controlled = '$id:$action',
            ),
          ),
          historyProvider.overrideWith2((id) => _FakeHistory(id, const [])),
        ],
        child: DefaultAssetBundle(
          bundle: _FakeAssetBundle(),
          child: const MaterialApp(
            home: ProjectDetailScreen(projectId: 'codex'),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byTooltip('停止任务'), findsOneWidget);
    expect(find.byTooltip('追加指令'), findsNothing);
    await tester.enterText(find.byType(TextField), '  \n ');
    await tester.pump();
    expect(find.byTooltip('停止任务'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '先补测试');
    await tester.pump();
    expect(find.byTooltip('停止任务'), findsNothing);
    expect(find.byTooltip('追加指令'), findsOneWidget);
    expect(find.byKey(const ValueKey('composer-action')), findsOneWidget);
    await tester.tap(find.byTooltip('追加指令'));
    await tester.pump();
    expect(submitted, 'turn:先补测试');
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
    );
    expect(find.textContaining('正在修改'), findsOneWidget);
    expect(find.byTooltip('停止任务'), findsOneWidget);
    expect(find.byTooltip('追加指令'), findsNothing);
    await tester.enterText(find.byType(TextField), '暂存的草稿');
    await tester.pump();
    await tester.tap(find.byTooltip('会话操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('停止当前任务'));
    await tester.pumpAndSettle();
    expect(controlled, 'turn:stop');
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '暂存的草稿',
    );
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(milliseconds: 200));
  });

  testWidgets(
    'Codex question requires an answer and submits the selected option',
    (tester) async {
      Map<String, String>? answers;
      const approval = Approval(
        approvalId: 'input',
        sessionId: 's',
        projectId: 'p',
        kind: 'input',
        title: '选择环境',
        createdAt: 1,
        questions: [
          InputQuestion(
            id: 'env',
            question: '部署到哪里？',
            options: [(label: '测试', description: '测试环境')],
          ),
        ],
      );
      const state = MonitorState(
        status: WsStatus.connected,
        approvals: {'input': approval},
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            monitorProvider.overrideWith(
              () => _FakeMonitor(state, onAnswer: (value) => answers = value),
            ),
          ],
          child: DefaultAssetBundle(
            bundle: _FakeAssetBundle(),
            child: MaterialApp(
              home: Consumer(
                builder: (context, ref, _) => Scaffold(
                  body: TextButton(
                    onPressed: () => showApprovalDrawer(context, ref, approval),
                    child: const Text('打开问题'),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('打开问题'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('发送回复'));
      await tester.pump();
      expect(answers, isNull);
      await tester.tap(find.text('测试'));
      await tester.tap(find.text('发送回复'));
      await tester.pumpAndSettle();
      expect(answers, {'env': '测试'});
    },
  );

  testWidgets(
    'read-only remote sessions show their source and disable controls',
    (tester) async {
      const project = Project(
        projectId: 'remote',
        name: 'Remote project',
        cwd: '/repo',
        status: 'running',
        agentId: 'worker',
        agentName: 'Custom Worker',
        nodeId: 'linux',
        nodeName: 'Linux host',
        online: true,
        capabilities: [],
        activeSessionId: 'remote-session',
        sessions: [
          Session(
            sessionId: 'remote-session',
            status: 'running',
            summary: 'Remote task',
          ),
        ],
      );
      await tester.pumpWidget(
        _host(
          const MonitorState(
            status: WsStatus.connected,
            serverProjects: {'remote': project},
          ),
        ),
      );
      await tester.pump();
      await _showSessions(tester);
      expect(find.textContaining('Custom Worker'), findsWidgets);
      await tester.tap(find.text('Remote task'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, false);
      expect(find.text('此任务仅支持监控'), findsOneWidget);
      await tester.tap(find.byType(PopupMenuButton<String>));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<PopupMenuItem<String>>(
              find.byWidgetPredicate(
                (w) => w is PopupMenuItem<String> && w.value == 'new',
              ),
            )
            .enabled,
        false,
      );
    },
  );

  testWidgets(
    'agent registry filters projects without mixing identical machine paths',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1200, 900));
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      const agents = {
        'worker-a': AgentInfo(
          agentId: 'worker-a',
          name: 'Worker A',
          provider: 'custom',
          nodeId: 'host-a',
          nodeName: 'Host A',
          online: true,
        ),
        'worker-b': AgentInfo(
          agentId: 'worker-b',
          name: 'Worker B',
          provider: 'custom',
          nodeId: 'host-b',
          nodeName: 'Host B',
          online: false,
        ),
      };
      const projects = {
        'a': Project(
          projectId: 'a',
          name: 'Project A',
          cwd: '/same',
          status: 'running',
          agentId: 'worker-a',
          agentName: 'Worker A',
          nodeName: 'Host A',
        ),
        'b': Project(
          projectId: 'b',
          name: 'Project B',
          cwd: '/same',
          status: 'running',
          agentId: 'worker-b',
          agentName: 'Worker B',
          nodeName: 'Host B',
          online: false,
        ),
      };
      await tester.pumpWidget(
        _host(
          const MonitorState(
            status: WsStatus.connected,
            agents: agents,
            serverProjects: projects,
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.text('项目'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('远程主机与 Agent'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Worker A'));
      await tester.pumpAndSettle();
      expect(find.text('Project A'), findsWidgets);
      expect(find.text('Project B'), findsNothing);
      await tester.tap(find.byTooltip('显示全部 Agent'));
      await tester.pumpAndSettle();
      expect(find.text('Project B'), findsWidgets);
    },
  );

  testWidgets('F1 lists each project\'s real sessions', (tester) async {
    final state = MonitorState(
      status: WsStatus.connected,
      serverProjects: {'D--cc-project': _ccProject()},
    );
    await tester.pumpWidget(_host(state));
    await tester.pump();
    await _showSessions(tester);
    expect(find.textContaining('cc_project'), findsWidgets);
    expect(
      find.text('Build Claude task monitoring Flutter app'),
      findsOneWidget,
    );
    expect(find.text('Hello test'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Create super Mario game with high fidelity'),
      180,
      scrollable: find
          .descendant(
            of: find.byType(CustomScrollView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(
      find.text('Create super Mario game with high fidelity'),
      findsOneWidget,
    );
  });

  testWidgets('Tapping a session row opens that session in F2', (tester) async {
    final state = MonitorState(
      status: WsStatus.connected,
      serverProjects: {'D--cc-project': _ccProject()},
    );
    await tester.pumpWidget(_host(state));
    await tester.pump();
    await _showSessions(tester);
    await tester.tap(find.text('Hello test'));
    await tester.pumpAndSettle();

    final detail = tester.widget<ProjectDetailScreen>(
      find.byType(ProjectDetailScreen),
    );
    expect(detail.projectId, 'D--cc-project');
    expect(
      detail.sessionId,
      's-hello',
    ); // the tapped session, not the active one
  });

  testWidgets('Search narrows sessions without changing project identities', (
    tester,
  ) async {
    final state = MonitorState(
      status: WsStatus.connected,
      serverProjects: {'D--cc-project': _ccProject()},
    );
    await tester.pumpWidget(_host(state));
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'Hello');
    await tester.pump();
    await _showSessions(tester);
    expect(find.text('Hello test'), findsOneWidget);
    expect(
      find.text('Create super Mario game with high fidelity'),
      findsNothing,
    );
  });
  testWidgets('F2 auto-scrolls to the newest message on open', (tester) async {
    // Small phone-ish viewport so the timeline overflows and can scroll.
    await tester.binding.setSurfaceSize(const Size(390, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    // 50 assistant messages -> the timeline overflows the viewport.
    final events = <TaskEvent>[
      for (var i = 50; i >= 1; i--) // newest-first (provider contract)
        TaskEvent(
          id: i,
          sessionId: 's-active',
          hookEventName: 'AssistantText',
          status: 'running',
          summary: 'Claude',
          detail: 'Message number $i in the conversation timeline.',
          createdAt: i * 1000,
        ),
    ];
    final state = MonitorState(
      status: WsStatus.connected,
      serverProjects: {'D--cc-project': _ccProject()},
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          monitorProvider.overrideWith(() => _FakeMonitor(state)),
          historyProvider.overrideWith2((id) => _FakeHistory(id, events)),
        ],
        child: DefaultAssetBundle(
          bundle: _FakeAssetBundle(),
          child: const MaterialApp(
            home: ProjectDetailScreen(
              projectId: 'D--cc-project',
              sessionId: 's-active',
            ),
          ),
        ),
      ),
    );
    // Let the FutureProvider resolve, the post-frame jump run, and the 120ms
    // settle-pass fire.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();

    // The conversation actually rendered bubbles (sanity check).
    expect(find.byType(ChatBubble), findsWidgets);

    final scrollable = tester.state<ScrollableState>(
      find.descendant(
        of: find.byType(ListView),
        matching: find.byType(Scrollable),
      ),
    );
    final pos = scrollable.position;
    expect(
      pos.maxScrollExtent,
      greaterThan(0),
    ); // content overflows -> can scroll
    expect(pos.pixels, 0);
    expect(find.textContaining('Message number 50'), findsOneWidget);
  });

  testWidgets(
    'new streaming output preserves the message being read and allows returning to latest',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final events = [
        for (var i = 40; i > 0; i--)
          TaskEvent(
            id: i,
            eventKey: 'm$i',
            sessionId: 's-active',
            hookEventName: 'UserPromptSubmit',
            status: 'done',
            detail: 'Historical message $i',
            createdAt: i * 1000,
          ),
      ];
      final state = MonitorState(
        status: WsStatus.connected,
        serverProjects: {'D--cc-project': _ccProject()},
      );
      final monitor = _FakeMonitor(state);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            monitorProvider.overrideWith(() => monitor),
            historyProvider.overrideWith2((id) => _FakeHistory(id, events)),
          ],
          child: DefaultAssetBundle(
            bundle: _FakeAssetBundle(),
            child: const MaterialApp(
              home: ProjectDetailScreen(
                projectId: 'D--cc-project',
                sessionId: 's-active',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final scrollable = tester.state<ScrollableState>(
        find.descendant(
          of: find.byType(ListView),
          matching: find.byType(Scrollable),
        ),
      );
      scrollable.position.jumpTo(480);
      await tester.pumpAndSettle();
      final visible =
          find
                  .byType(ChatBubble)
                  .evaluate()
                  .where((element) {
                    final y = tester
                        .getTopLeft(find.byWidget(element.widget))
                        .dy;
                    return y > 220 && y < 420;
                  })
                  .first
                  .widget
              as ChatBubble;
      Finder anchor() => find.byWidgetPredicate(
        (w) => w is ChatBubble && w.message.id == visible.message.id,
      );
      final before = tester.getTopLeft(anchor()).dy;
      monitor.update(
        state.copyWith(
          streaming: {'s-active': 'New output is arriving. ' * 12},
          streamingPhases: {'s-active': 'final_answer'},
          streamingItems: {'s-active': 'new-reply'},
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(tester.getTopLeft(anchor()).dy, closeTo(before, 1));
      expect(find.text('回到最新'), findsOneWidget);
      await tester.tap(find.text('回到最新'));
      await tester.pumpAndSettle();
      expect(scrollable.position.pixels, 0);
      expect(find.text('回到最新'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
