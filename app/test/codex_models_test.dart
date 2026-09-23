import 'package:flutter_test/flutter_test.dart';
import 'package:claude_monitor/models.dart';
import 'package:claude_monitor/chat_builder.dart';

void main() {
  test('history without timestamps does not invent a current-day divider', () {
    final messages = buildChat(const [
      TaskEvent(
        sessionId: 'old',
        hookEventName: 'AssistantText',
        status: 'done',
        detail: 'Historical reply',
      ),
    ]);
    expect(messages.where((m) => m.kind == ChatKind.timestamp), isEmpty);
    expect(messages.single.text, 'Historical reply');
  });
  test(
    'session permissions restrict a capable agent without blocking new tasks',
    () {
      final project = Project.fromJson({
        'projectId': 'p',
        'provider': 'codex',
        'capabilities': [
          'message.send',
          'message.steer',
          'session.start',
          'session.stop',
        ],
        'sessions': [
          {
            'session_id': 'read-only',
            'capabilities': <String>[],
            'controlReason': '其他客户端占用',
          },
          {
            'session_id': 'owned',
            'capabilities': ['message.send', 'message.steer', 'session.stop'],
          },
        ],
      });
      expect(project.canForSession('read-only', 'message.send'), false);
      expect(project.canForSession('read-only', 'session.stop'), false);
      expect(project.canForSession('owned', 'message.steer'), true);
      expect(project.can('session.start'), true);
      expect(
        project.withState(status: 'running').sessions.first.controlReason,
        '其他客户端占用',
      );
    },
  );

  test('parallel Codex tools keep their own output and diff', () {
    TaskEvent event(
      String hook,
      String id,
      String text, {
      String tool = 'Terminal',
    }) => TaskEvent(
      sessionId: 's',
      hookEventName: hook,
      toolName: tool,
      toolCallId: id,
      detail: text,
      status: 'running',
    );
    final messages = buildChat([
      event('PreToolUse', 'a', 'command A'),
      event('PreToolUse', 'b', 'command B'),
      event('ToolOutput', 'a', 'live A'),
      event('PostToolUse', 'b', 'done B'),
      event('PreToolUse', 'c', 'file', tool: 'FileChange'),
      event('PostToolUse', 'c', '-old\n+new', tool: 'FileChange'),
    ]).where((m) => m.toolName != null).toList();
    expect(messages, hasLength(3));
    expect(messages[0].toolArgs, 'command A');
    expect(messages[0].toolOutput, 'live A');
    expect(messages[0].active, true);
    expect(messages[1].toolArgs, 'command B');
    expect(messages[1].toolOutput, 'done B');
    expect(messages[1].active, false);
    expect(messages[2].kind, ChatKind.toolEdit);
    expect(messages[2].addCount, 1);
  });

  test('input requests expose real choices and a reply entry', () {
    final approval = Approval.fromJson({
      'approvalId': 'input',
      'sessionId': 's',
      'kind': 'input',
      'title': '需要你的回复',
      'questions': [
        {
          'id': 'target',
          'question': '选择环境',
          'options': [
            {'label': '测试', 'description': '测试环境'},
          ],
        },
      ],
    });
    expect(approval.questions.first.options.first.label, '测试');
    expect(
      buildChat([], pendingApproval: approval).single.text,
      contains('等待回复'),
    );
  });
}
