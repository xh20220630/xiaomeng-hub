import 'dart:convert';
import 'chat_builder.dart';
import 'models.dart';

bool isActivity(ChatMessage message) => const {
  ChatKind.toolBash,
  ChatKind.toolEdit,
  ChatKind.thinking,
  ChatKind.commentary,
}.contains(message.kind);

class ConversationEntry {
  final String id;
  final List<ChatMessage> messages;
  final bool activity;
  const ConversationEntry(this.id, this.messages, {this.activity = false});
}

List<ConversationEntry> presentConversation(List<ChatMessage> messages) {
  final entries = <ConversationEntry>[];
  var pending = <ChatMessage>[];
  void flush() {
    if (pending.isEmpty) return;
    entries.add(
      ConversationEntry(
        'activity:${pending.first.id ?? pending.first.createdAt ?? entries.length}',
        pending,
        activity: true,
      ),
    );
    pending = [];
  }

  for (final message in messages) {
    if (isActivity(message)) {
      if (pending.isNotEmpty &&
          message.turnId != null &&
          pending.last.turnId != null &&
          message.turnId != pending.last.turnId) {
        flush();
      }
      pending.add(message);
    } else {
      flush();
      entries.add(
        ConversationEntry(
          '${message.kind.name}:${message.id ?? message.createdAt ?? entries.length}',
          [message],
        ),
      );
    }
  }
  flush();
  return entries;
}

String eventIdentity(TaskEvent event) =>
    event.eventKey ?? '${event.id}:${event.hookEventName}:${event.detail}';

List<TaskEvent> mergeConversationEvents(
  List<TaskEvent> history,
  List<TaskEvent> live,
) {
  final result = history.reversed.toList();
  final completed = {
    for (final e in history)
      if (const [
            'PostToolUse',
            'PostToolUseFailure',
          ].contains(e.hookEventName) &&
          e.toolCallId != null)
        e.toolCallId,
  };
  final identities = result.map(eventIdentity).toSet();
  final anchored = live.any((e) => identities.contains(eventIdentity(e)));
  var insertion = anchored ? 0 : result.length;
  for (final event in live.reversed) {
    if (completed.contains(event.toolCallId) &&
        const ['PreToolUse', 'ToolOutput'].contains(event.hookEventName)) {
      continue;
    }
    final index = result.indexWhere(
      (e) => eventIdentity(e) == eventIdentity(event),
    );
    if (index >= 0) {
      // History can enrich events cached before phase metadata was introduced.
      if (result[index].phase == null || event.phase != null) {
        result[index] = event;
      }
      insertion = index + 1;
    } else {
      result.insert(insertion++, event);
    }
  }
  return result;
}

List<ChatMessage> withStreamingReply(
  List<ChatMessage> messages, {
  String? text,
  String? phase,
  String? itemId,
  String? turnId,
}) {
  if (text == null || text.isEmpty) return messages;
  final index = itemId == null
      ? -1
      : messages.indexWhere((m) => m.id == itemId);
  final reply = ChatMessage(
    phase == 'commentary' ? ChatKind.commentary : ChatKind.assistantText,
    id: itemId ?? 'streaming:${turnId ?? 'current'}',
    turnId: turnId,
    text: text,
    active: true,
  );
  if (index < 0) return [...messages, reply];
  final updated = [...messages];
  updated[index] = reply;
  return updated;
}

class ActivityLabel {
  final String title;
  final String category;
  final String? subject;
  const ActivityLabel(this.title, this.category, [this.subject]);
}

({String text, bool hasContext, bool hasImage}) presentUserMessage(String raw) {
  final contextEnd = raw.indexOf('</in-app-browser-context>');
  final request = contextEnd < 0
      ? -1
      : raw.indexOf('## My request:', contextEnd);
  if (request < 0) return (text: raw, hasContext: false, hasImage: false);
  final content = raw.substring(request + '## My request:'.length).trim();
  final hasImage =
      content.endsWith('[localImage]') || content.endsWith('[image]');
  final text = hasImage
      ? content.replaceFirst(RegExp(r'\s*\[(localImage|image)\]$'), '').trim()
      : content;
  return (text: text, hasContext: true, hasImage: hasImage);
}

ActivityLabel describeActivity(ChatMessage message) {
  if (message.kind == ChatKind.userText) {
    return const ActivityLabel('原始消息', '消息与附带上下文');
  }
  final tool = message.toolName ?? '';
  final name = tool.toLowerCase();
  final input = message.toolArgs ?? '';
  Map? arguments;
  try {
    final decoded = jsonDecode(input);
    if (decoded is Map) arguments = decoded;
  } catch (_) {}
  final suppliedTitle = arguments?['title'];
  if (message.kind == ChatKind.thinking) {
    return const ActivityLabel('整理思路', '思考摘要');
  }
  if (message.kind == ChatKind.commentary) {
    return const ActivityLabel('进度更新', '进度');
  }
  if (name.contains('cua') ||
      name.contains('browser') ||
      name.contains('playwright')) {
    return ActivityLabel(
      suppliedTitle is String && suppliedTitle.length <= 120
          ? suppliedTitle
          : '查看与操作页面',
      '浏览器',
    );
  }
  if (message.kind == ChatKind.toolEdit) {
    final first = input.split('\n').first.trim();
    final path = first.startsWith('--- ') ? first.substring(4) : first;
    return ActivityLabel(
      name == 'diff' ? '查看文件变更' : '更新文件',
      '文件',
      path.split(RegExp(r'[\\/]')).last,
    );
  }
  if (const ['terminal', 'bash', 'powershell'].contains(name)) {
    var command = input.trim();
    final wrapper = RegExp(
      r'-Command\s+[\x27\x22]?([\s\S]+)',
      caseSensitive: false,
    ).firstMatch(command);
    if (wrapper != null) command = wrapper.group(1)!;
    final first = command.split('\n').first.trim();
    if (RegExp(
      r'(flutter|dart|npm|pnpm|node|pytest|cargo|go).{0,35}(test|--test)',
    ).hasMatch(first)) {
      return ActivityLabel('运行测试', '终端', first);
    }
    if (RegExp(r'\b(build|analyze|typecheck|lint)\b').hasMatch(first)) {
      return ActivityLabel(
        first.contains('build') ? '构建项目' : '检查代码',
        '终端',
        first,
      );
    }
    if (RegExp(r'^(rg|grep)\b').hasMatch(first)) {
      return ActivityLabel('检索代码', '搜索', first);
    }
    if (RegExp(r'^(Get-Content|cat|head|tail)\b').hasMatch(first)) {
      return const ActivityLabel('读取文件', '文件');
    }
    if (RegExp(r'^(Get-ChildItem|ls|dir)\b').hasMatch(first)) {
      return const ActivityLabel('查看目录', '文件');
    }
    return ActivityLabel('运行命令', '终端', first);
  }
  if (name.contains('search') || name == 'grep' || name == 'glob') {
    return const ActivityLabel('搜索相关内容', '搜索');
  }
  if (name.contains('read') || name == 'read') {
    return const ActivityLabel('读取内容', '文件');
  }
  if (name.contains('plan') || name.contains('todo')) {
    return const ActivityLabel('更新执行计划', '计划');
  }
  final short = tool.split('/').last;
  return ActivityLabel(short.isEmpty ? '调用工具' : short, '工具');
}
