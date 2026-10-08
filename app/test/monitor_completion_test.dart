import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:claude_monitor/models.dart';
import 'package:claude_monitor/services/api_service.dart';
import 'package:claude_monitor/services/notifications/notification_service_stub.dart';
import 'package:claude_monitor/state/monitor.dart';
import 'package:claude_monitor/state/history.dart';
import 'package:claude_monitor/state/settings.dart';

class _Api extends ApiService {
  _Api() : super('http://localhost');
  int historyReads = 0;
  Completer<HistoryPage>? pendingHistory;
  final initialProjects = Completer<List<Project>>();
  @override
  Future<HistoryPage> getHistory(String sessionId, {String? cursor}) async {
    historyReads++;
    return pendingHistory?.future ?? const HistoryPage([], null);
  }

  @override
  Future<List<AgentInfo>> getAgents() async => [];
  @override
  Future<List<Session>> getSessions() async => [];
  @override
  Future<List<Project>> getProjects() => initialProjects.future;
  @override
  Future<List<Approval>> getApprovals() async => [];
  @override
  Future<List<TaskEvent>> getEvents(
    String sessionId, {
    int limit = 200,
  }) async => [];
}

Future<void> _until(bool Function() check) async {
  final deadline = DateTime.now().add(const Duration(seconds: 3));
  while (!check()) {
    if (DateTime.now().isAfter(deadline)) fail('状态未按预期同步');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

Map<String, dynamic> _project(String status, int updatedAt) => {
  'projectId': 'p',
  'name': 'Project',
  'status': status,
  'activeSessionId': 's',
  'lastEventAt': updatedAt,
  'sessions': [
    {'session_id': 's', 'status': status, 'updated_at': updatedAt},
  ],
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ProviderContainer container;
  late HttpServer server;
  late WebSocket socket;
  MonitorState current() => container.read(monitorProvider);
  void send(Map<String, dynamic> message) => socket.add(jsonEncode(message));

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final connected = Completer<WebSocket>();
    server.listen((request) async {
      final ws = await WebSocketTransformer.upgrade(request);
      ws.listen((_) {});
      connected.complete(ws);
    });
    SharedPreferences.setMockInitialValues({
      'host': '127.0.0.1',
      'port': server.port,
    });
    container = ProviderContainer(
      overrides: [
        sharedPrefsProvider.overrideWithValue(
          await SharedPreferences.getInstance(),
        ),
        apiServiceProvider.overrideWithValue(_Api()),
        notificationServiceProvider.overrideWithValue(
          NotificationServiceImpl(),
        ),
      ],
    );
    container.read(monitorProvider);
    socket = await connected.future;
  });

  tearDown(() async {
    final api = container.read(apiServiceProvider) as _Api;
    if (!api.initialProjects.isCompleted) {
      api.initialProjects.complete([]);
      await Future<void>.delayed(Duration.zero);
    }
    container.dispose();
    await socket.close();
    await server.close(force: true);
  });

  test(
    'a fast completion snapshot prevents a late new-session placeholder',
    () async {
      send({'type': 'project.update', 'project': _project('done', 100)});
      await _until(() => current().serverProjects['p']?.status == 'done');
      container.read(monitorProvider.notifier).primeNewSession('s', '创建任务');
      expect(current().pendingUser, isEmpty);
      expect(current().streaming, isEmpty);
    },
  );

  test(
    'assistant.start retains protection against the previous completion',
    () async {
      send({'type': 'project.update', 'project': _project('done', 100)});
      await _until(() => current().serverProjects.containsKey('p'));
      container.read(monitorProvider.notifier).sendMessage('s', '继续');
      send({'type': 'assistant.start', 'sessionId': 's', 'turnId': 'new'});
      send({
        'type': 'projects.snapshot',
        'projects': [_project('done', 100)],
      });
      send({'type': 'command.error', 'operation': 'test', 'error': 'barrier'});
      await _until(() => current().commandError == 'barrier');
      expect(current().streamingTurns['s'], 'new');
      expect(current().pendingUser['s'], '继续');
      send({'type': 'project.update', 'project': _project('running', 200)});
      await _until(() => current().serverProjects['p']?.status == 'running');
      send({'type': 'project.update', 'project': _project('done', 200)});
      await _until(() => current().streaming.isEmpty);
      expect(current().pendingUser, isEmpty);
    },
  );

  test('a late create response preserves an already running reply', () async {
    send({'type': 'project.update', 'project': _project('running', 100)});
    send({'type': 'assistant.start', 'sessionId': 's', 'turnId': 'new'});
    send({
      'type': 'assistant.delta',
      'sessionId': 's',
      'turnId': 'new',
      'text': '回复正文',
    });
    await _until(() => current().streaming['s'] == '回复正文');
    container.read(monitorProvider.notifier).primeNewSession('s', '创建任务');
    expect(current().streaming['s'], '回复正文');
    send({
      'type': 'projects.snapshot',
      'projects': [_project('done', 100)],
    });
    await _until(() => current().streaming.isEmpty);
    expect(current().pendingUser, isEmpty);
  });

  test('older running updates and snapshots cannot undo completion', () async {
    send({'type': 'project.update', 'project': _project('done', 200)});
    await _until(() => current().serverProjects['p']?.status == 'done');
    send({'type': 'project.update', 'project': _project('running', 100)});
    send({
      'type': 'projects.snapshot',
      'projects': [_project('running', 100)],
    });
    send({
      'type': 'snapshot',
      'sessions': [
        {'session_id': 's', 'status': 'running', 'updated_at': 100},
      ],
    });
    send({'type': 'command.error', 'operation': 'test', 'error': 'barrier'});
    await _until(() => current().commandError == 'barrier');
    expect(current().serverProjects['p']?.status, 'done');
    expect(current().sessions['s']?.status, 'done');
    container.read(monitorProvider.notifier).primeNewSession('s', '旧响应');
    expect(current().streaming, isEmpty);
  });

  test(
    'a late initial REST response cannot replace a live completion',
    () async {
      send({'type': 'project.update', 'project': _project('done', 200)});
      await _until(() => current().serverProjects['p']?.status == 'done');
      final api = container.read(apiServiceProvider) as _Api;
      api.initialProjects.complete([
        Project.fromJson(_project('running', 200)),
      ]);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(current().serverProjects['p']?.status, 'done');
    },
  );

  test('legacy completion without timestamps still clears a reply', () async {
    send({
      'type': 'snapshot',
      'sessions': [
        {'session_id': 's', 'status': 'done'},
      ],
    });
    send({'type': 'command.error', 'operation': 'test', 'error': 'initial'});
    await _until(() => current().commandError == 'initial');
    container.read(monitorProvider.notifier).sendMessage('s', '继续');
    send({'type': 'assistant.start', 'sessionId': 's'});
    send({
      'type': 'snapshot',
      'sessions': [
        {'session_id': 's', 'status': 'done'},
      ],
    });
    send({'type': 'command.error', 'operation': 'test', 'error': 'barrier'});
    await _until(() => current().commandError == 'barrier');
    expect(current().streaming, isEmpty);
    expect(current().pendingUser, isEmpty);
  });

  test(
    'completion during a history request queues a final history refresh',
    () async {
      send({'type': 'project.update', 'project': _project('running', 100)});
      await _until(() => current().serverProjects.containsKey('p'));
      final api = container.read(apiServiceProvider) as _Api;
      final request = Completer<HistoryPage>();
      api.pendingHistory = request;
      final subscription = container.listen(historyProvider('s'), (_, _) {});
      addTearDown(subscription.close);
      await _until(() => api.historyReads == 1);
      send({'type': 'project.update', 'project': _project('done', 100)});
      await _until(() => current().serverProjects['p']?.status == 'done');
      await Future<void>.delayed(const Duration(milliseconds: 450));
      api.pendingHistory = null;
      request.complete(const HistoryPage([], null));
      await _until(() => api.historyReads == 2);
    },
  );

  for (final terminal in ['done', 'error', 'paused', 'ended']) {
    test(
      '$terminal project snapshot clears a stream when assistant.done was missed',
      () async {
        send({'type': 'assistant.start', 'sessionId': 's', 'turnId': 'turn'});
        send({
          'type': 'assistant.delta',
          'sessionId': 's',
          'turnId': 'turn',
          'itemId': 'reply',
          'phase': 'commentary',
          'text': '处理中',
        });
        await _until(() => current().streaming['s'] == '处理中');
        send({
          'type': 'projects.snapshot',
          'projects': [_project(terminal, 200)],
        });
        await _until(() => current().serverProjects['p']?.status == terminal);
        expect(current().streaming, isEmpty);
        expect(current().streamingPhases, isEmpty);
        expect(current().streamingItems, isEmpty);
        expect(current().streamingTurns, isEmpty);

        send({
          'type': 'assistant.delta',
          'sessionId': 's',
          'turnId': 'turn',
          'text': '',
        });
        send({
          'type': 'command.error',
          'operation': 'test',
          'error': 'barrier',
        });
        await _until(() => current().commandError == 'barrier');
        expect(current().streaming, isEmpty);
        send({'type': 'assistant.start', 'sessionId': 's', 'turnId': 'next'});
        await _until(() => current().streamingTurns['s'] == 'next');
        expect(current().streaming.containsKey('s'), isTrue);
      },
    );
  }

  test(
    'completion update clears pending input but an old snapshot keeps a new send',
    () async {
      send({'type': 'project.update', 'project': _project('done', 100)});
      await _until(() => current().serverProjects.containsKey('p'));
      expect(
        container.read(monitorProvider.notifier).sendMessage('s', '继续'),
        isTrue,
      );
      send({
        'type': 'projects.snapshot',
        'projects': [_project('done', 100)],
      });
      send({
        'type': 'command.error',
        'operation': 'test',
        'error': 'old snapshot',
      });
      await _until(() => current().commandError == 'old snapshot');
      expect(current().pendingUser['s'], '继续');
      expect(current().streaming.containsKey('s'), isTrue);

      send({'type': 'project.update', 'project': _project('done', 200)});
      await _until(() => current().serverProjects['p']?.lastEventAt == 200);
      expect(current().pendingUser, isEmpty);
      expect(current().streaming, isEmpty);
    },
  );

  test(
    'late completion for an older turn does not clear the current reply',
    () async {
      send({'type': 'assistant.start', 'sessionId': 's', 'turnId': 'new'});
      await _until(() => current().streamingTurns['s'] == 'new');
      send({'type': 'assistant.done', 'sessionId': 's', 'turnId': 'old'});
      send({'type': 'command.error', 'operation': 'test', 'error': 'barrier'});
      await _until(() => current().commandError == 'barrier');
      expect(current().streamingTurns['s'], 'new');
    },
  );

  test(
    'failed project status preserves the input for the following error receipt',
    () async {
      send({'type': 'project.update', 'project': _project('done', 100)});
      await _until(() => current().serverProjects.containsKey('p'));
      container.read(monitorProvider.notifier).sendMessage('s', '重试内容');
      send({'type': 'assistant.start', 'sessionId': 's', 'turnId': 'turn'});
      send({'type': 'project.update', 'project': _project('error', 200)});
      send({
        'type': 'assistant.done',
        'sessionId': 's',
        'turnId': 'turn',
        'ok': false,
        'error': '主机执行失败',
      });
      await _until(() => current().failedSends['s']?.error == '主机执行失败');
      expect(current().failedSends['s']?.text, '重试内容');
      expect(current().streaming, isEmpty);
      expect(current().pendingUser, isEmpty);
    },
  );

  test(
    'a terminal status refreshes final history even when its timestamp is unchanged',
    () async {
      send({'type': 'project.update', 'project': _project('running', 100)});
      await _until(() => current().serverProjects.containsKey('p'));
      final subscription = container.listen(historyProvider('s'), (_, _) {});
      addTearDown(subscription.close);
      final api = container.read(apiServiceProvider) as _Api;
      await _until(() => api.historyReads == 1);
      send({'type': 'project.update', 'project': _project('done', 100)});
      await _until(() => api.historyReads == 2);
    },
  );
}
