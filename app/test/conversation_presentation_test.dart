import 'package:flutter_test/flutter_test.dart';
import 'package:claude_monitor/chat_builder.dart';
import 'package:claude_monitor/conversation_presentation.dart';
import 'package:claude_monitor/models.dart';

TaskEvent event(
  String id,
  String hook, {
  String? phase,
  String? call,
  String? input,
  String? detail,
}) => TaskEvent(
  sessionId: 's',
  eventKey: id,
  itemId: id,
  turnId: 'turn',
  hookEventName: hook,
  status: 'running',
  phase: phase,
  toolCallId: call,
  toolName: call == null ? null : 'Terminal',
  toolInput: input,
  detail: detail ?? id,
);

void main() {
  test(
    'desktop context is kept in the original while the user request is readable',
    () {
      const raw =
          '# Files mentioned by the user:\nlocal path\n<in-app-browser-context source="ambient-ui-state">\nBrowser metadata\n</in-app-browser-context>\n\n## My request:\n优化输出界面\n[localImage]';
      final content = presentUserMessage(raw);
      expect(content.text, '优化输出界面');
      expect(content.hasImage, true);
      expect(content.hasContext, true);
    },
  );
  test(
    'ordinary messages and quoted context without a request are preserved verbatim',
    () {
      for (final raw in [
        '## My request:\nKeep this heading',
        'Explain <in-app-browser-context> example </in-app-browser-context>',
        'Normal message',
      ]) {
        expect(presentUserMessage(raw).text, raw);
        expect(presentUserMessage(raw).hasContext, false);
      }
    },
  );
  test(
    'progress and tools collapse together while replies and approvals stay outside',
    () {
      final messages = buildChat(
        [
          event('user', 'UserPromptSubmit'),
          event('progress', 'AssistantText', phase: 'commentary'),
          event(
            'tool',
            'PostToolUse',
            call: 'call',
            input: 'npm test',
            detail: 'All passed',
          ),
          event('answer', 'AssistantText', phase: 'final_answer'),
        ],
        pendingApproval: const Approval(
          approvalId: 'a',
          kind: 'tool',
          sessionId: 's',
          projectId: 'p',
          title: '继续执行？',
          createdAt: 1,
        ),
      );
      final entries = presentConversation(messages);
      expect(entries.map((e) => e.activity), [false, true, false, false]);
      expect(entries[1].messages, hasLength(2));
      expect(entries.last.messages.single.kind, ChatKind.capsuleWaiting);
      expect(entries[1].messages.last.toolArgs, 'npm test');
      expect(entries[1].messages.last.toolOutput, 'All passed');
    },
  );

  test('adjacent activity from different turns is not merged', () {
    final entries = presentConversation(const [
      ChatMessage(ChatKind.commentary, id: 'a', turnId: '1'),
      ChatMessage(ChatKind.toolBash, id: 'b', turnId: '2'),
    ]);
    expect(entries, hasLength(2));
  });

  test(
    'fresh history enriches cached events without moving replies before their tools',
    () {
      final first = event('first', 'AssistantText', phase: 'commentary');
      final tool = event('tool', 'PostToolUse', call: 'call');
      final answer = event('answer', 'AssistantText', phase: 'final_answer');
      final merged = mergeConversationEvents(
        [answer, tool, first],
        [
          event('next', 'UserPromptSubmit'),
          event('answer', 'AssistantText'),
          event('late-output', 'ToolOutput', call: 'call'),
          event('tool', 'PostToolUse', call: 'call'),
        ],
      );
      expect(merged.map((e) => e.eventKey), [
        'first',
        'tool',
        'answer',
        'next',
      ]);
      expect(merged[2].phase, 'final_answer');
    },
  );

  test('late tool deltas never revive completed or failed calls', () {
    final messages = buildChat([
      event('start', 'PreToolUse', call: 'a'),
      event('failed', 'PostToolUseFailure', call: 'a'),
      event('late', 'ToolOutput', call: 'a'),
      event('repeat-start', 'PreToolUse', call: 'a'),
    ]);
    expect(messages, hasLength(1));
    expect(messages.single.active, false);
    expect(messages.single.ok, false);
    expect(messages.single.toolOutput, 'failed');
  });

  test(
    'a stream updates its existing message in place and keeps the activity identity',
    () {
      final messages = buildChat([
        event('progress', 'AssistantText', phase: 'commentary'),
        event('tool', 'PostToolUse', call: 'call'),
      ]);
      final before = presentConversation(messages).single.id;
      final streamed = withStreamingReply(
        messages,
        text: 'New progress',
        phase: 'commentary',
        itemId: 'progress',
        turnId: 'turn',
      );
      expect(streamed, hasLength(2));
      expect(streamed.first.text, 'New progress');
      expect(streamed.first.active, true);
      expect(presentConversation(streamed).single.id, before);
      expect(withStreamingReply(messages, text: ''), same(messages));
    },
  );

  test('streaming final answers retain their item key on completion', () {
    final streaming = withStreamingReply(
      [],
      text: 'Answer',
      phase: 'final_answer',
      itemId: 'answer',
      turnId: 'turn',
    );
    final completed = buildChat([
      event('answer', 'AssistantText', phase: 'final_answer', detail: 'Answer'),
    ]);
    expect(
      presentConversation(streaming).single.id,
      presentConversation(completed).single.id,
    );
    expect(completed.single.active, false);
  });

  test('readable titles retain real commands in details', () {
    const message = ChatMessage(
      ChatKind.toolBash,
      toolName: 'Terminal',
      toolArgs: 'npm test',
    );
    expect(describeActivity(message).title, '运行测试');
    expect(message.toolArgs, 'npm test');
    expect(
      describeActivity(
        const ChatMessage(
          ChatKind.toolBash,
          toolName: 'cua_repl/js',
          toolArgs: '{"title":"检查手机布局"}',
        ),
      ).title,
      '检查手机布局',
    );
  });
}
