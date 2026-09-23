import 'package:flutter_test/flutter_test.dart';
import 'package:claude_monitor/models.dart';
import 'package:claude_monitor/state/monitor.dart';

void main() {
  test(
    'approval overlays preserve agent identity and read-only capabilities',
    () {
      final project = Project.fromJson({
        'projectId': 'remote-project',
        'name': 'Repo',
        'cwd': '/repo',
        'status': 'running',
        'agentId': 'worker-a',
        'agentName': 'Worker A',
        'provider': 'custom',
        'nodeId': 'host-a',
        'nodeName': 'Linux A',
        'online': false,
        'capabilities': <String>[],
      });
      final approval = Approval.fromJson({
        'approvalId': 'approval-a',
        'projectId': 'remote-project',
        'sessionId': 'session-a',
        'title': 'Proceed?',
        'kind': 'command',
        'status': 'pending',
        'createdAt': DateTime.now().millisecondsSinceEpoch,
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
      });
      final overlaid = MonitorState(
        serverProjects: {project.projectId: project},
        approvals: {approval.approvalId: approval},
      ).projects.single;
      expect(overlaid.status, 'needs_approval');
      expect(overlaid.activeSessionId, 'session-a');
      expect(overlaid.agentId, 'worker-a');
      expect(overlaid.nodeName, 'Linux A');
      expect(overlaid.online, false);
      expect(overlaid.can('message.send'), false);
      expect(overlaid.withState(clearApproval: true).capabilities, isEmpty);
    },
  );

  test('older Claude project payloads retain their supported operations', () {
    final project = Project.fromJson({'projectId': 'old', 'status': 'done'});
    expect(project.agentName, 'Claude Code');
    expect(project.can('session.start'), true);
  });
}
