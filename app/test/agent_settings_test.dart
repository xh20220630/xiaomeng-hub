import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:claude_monitor/models.dart';
import 'package:claude_monitor/services/api_service.dart';
import 'package:claude_monitor/widgets/agent_settings_sheet.dart';

class HostApi extends ApiService {
  HostApi() : super('http://localhost');
  Map<String, String>? saved;
  bool failSave = false;
  @override
  Future<Map<String, dynamic>> agentCatalog(
    String agentId,
    String sessionId,
  ) async => {
    'controlTransport': 'desktop-ipc',
    'models': [
      {
        'id': 'model-a',
        'name': 'Model A',
        'reasoningEfforts': ['low', 'high'],
      },
      {
        'id': 'model-b',
        'name': 'Model B',
        'reasoningEfforts': ['low'],
      },
    ],
    'modes': [
      {'id': 'default', 'name': '执行'},
      {'id': 'plan', 'name': '计划'},
    ],
  };
  @override
  Future<Map<String, dynamic>> configureSession(
    String sessionId,
    Map<String, String> settings,
  ) async {
    if (failSave) throw StateError('主机拒绝设置');
    saved = settings;
    return {'confirmed': true, 'appliesTo': 'next_turn'};
  }
}

void main() {
  const session = Session(
    sessionId: 'task',
    status: 'running',
    model: 'model-a',
    reasoningEffort: 'high',
    mode: 'default',
  );
  const project = Project(
    projectId: 'project',
    name: 'Project',
    cwd: '/',
    status: 'running',
    agentId: 'host',
    capabilities: ['agent.catalog', 'session.configure'],
    sessions: [session],
  );

  testWidgets(
    'switching model clears incompatible effort and confirms only after host success',
    (tester) async {
      final api = HostApi();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AgentSettingsSheet(
              api: api,
              project: project,
              session: session,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('已连接桌面会话'), findsOneWidget);
      await tester.tap(find.text('Model A').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Model B').last);
      await tester.pumpAndSettle();
      expect(find.text('high'), findsNothing);
      await tester.ensureVisible(find.text('应用到此会话'));
      await tester.tap(find.text('应用到此会话'));
      await tester.pumpAndSettle();
      expect(api.saved, {'model': 'model-b', 'mode': 'default'});
      expect(find.text('主机已确认，设置将在下一轮对话生效'), findsOneWidget);
      api.failSave = true;
      await tester.tap(find.text('应用到此会话'));
      await tester.pumpAndSettle();
      expect(find.textContaining('主机拒绝设置'), findsOneWidget);
      expect(find.text('主机已确认，设置将在下一轮对话生效'), findsNothing);
    },
  );
}
