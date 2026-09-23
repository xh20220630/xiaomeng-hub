import 'dart:convert';

import 'models.dart';

/// Visual message kinds for the F2 conversation view.
enum ChatKind {
  timestamp,
  assistantText,
  commentary,
  userText,
  thinking,
  toolBash,
  toolEdit,
  plan, // 📋 ExitPlanMode plan block (markdown)
  todo, // TodoWrite checklist card
  capsuleWaiting, // tappable -> open approval drawer
  capsuleApproved,
  capsuleRejected,
  capsuleInfo,
}

/// One TodoWrite checklist entry. [status]: pending | in_progress | completed.
class TodoItem {
  final String text;
  final String status;
  const TodoItem(this.text, this.status);
}

class ChatMessage {
  final ChatKind kind;
  final String? text;
  final String? toolTitle; // "Bash · npm test" (legacy)
  final String? toolName; // "Bash"
  final String? toolArgs; // "npm test"
  final String? toolOutput; // "✓ 24 passed" / "+6 −1"
  final bool? ok;
  final bool active; // tool still running
  final int? createdAt;
  final String? approvalId;
  final String? id;
  final String? turnId;
  final int? addCount; // Edit-block +N (added lines)
  final int? delCount; // Edit-block −N (deleted lines)
  final List<TodoItem>? todos;

  const ChatMessage(
    this.kind, {
    this.text,
    this.toolTitle,
    this.toolName,
    this.toolArgs,
    this.toolOutput,
    this.ok,
    this.active = false,
    this.createdAt,
    this.approvalId,
    this.id,
    this.turnId,
    this.addCount,
    this.delCount,
    this.todos,
  });
}

bool _isEditTool(String? t) =>
    t == 'Edit' ||
    t == 'Write' ||
    t == 'MultiEdit' ||
    t == 'NotebookEdit' ||
    t == 'FileChange' ||
    t == 'Diff';

/// Extract (+added, −deleted) from a tool result: either the server summary
/// "+6  −1" (U+2212 or ASCII minus) or, as a fallback, by counting +/- lines
/// of a unified diff (excluding +++/--- headers). Null when neither matches.
(int, int)? editStats(String? output) {
  if (output == null || output.isEmpty) return null;
  final m = RegExp(r'\+(\d+)\s+[−-](\d+)').firstMatch(output);
  if (m != null) return (int.parse(m.group(1)!), int.parse(m.group(2)!));
  if (!output.contains('\n')) return null;
  var add = 0, del = 0;
  var sawDiff = false;
  for (final line in output.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      sawDiff = true;
      continue;
    }
    if (line.startsWith('@@')) sawDiff = true;
    if (line.startsWith('+')) add++;
    if (line.startsWith('-')) del++;
  }
  if (!sawDiff && add == 0 && del == 0) return null;
  return (add > 0 || del > 0) ? (add, del) : null;
}

/// Best-effort parse of a TodoWrite payload. The server flattens tool_input
/// via rawToolInput, so today this usually gets null/unparseable text and we
/// skip the card; if the server later ships the todos JSON through `detail`,
/// this picks it up without an app update. Never invents data.
List<TodoItem>? tryParseTodos(String? detail) {
  if (detail == null || detail.trim().isEmpty) return null;
  dynamic j;
  try {
    j = jsonDecode(detail);
  } catch (_) {
    return null;
  }
  final list = j is Map ? j['todos'] : j;
  if (list is! List || list.isEmpty) return null;
  final out = <TodoItem>[];
  for (final e in list) {
    if (e is! Map) return null;
    final text = (e['content'] ?? e['activeForm'] ?? e['text'])?.toString();
    if (text == null || text.isEmpty) return null;
    out.add(TodoItem(text, (e['status'] ?? 'pending').toString()));
  }
  return out;
}

/// Builds the conversation from a chronological (oldest-first) event list.
/// Pairs Pre/PostToolUse into single tool blocks (command + result).
List<ChatMessage> buildChat(
  List<TaskEvent> chronological, {
  Approval? pendingApproval,
}) {
  final out = <ChatMessage>[];
  if (chronological.isNotEmpty && chronological.first.createdAt != null) {
    out.add(
      ChatMessage(ChatKind.timestamp, createdAt: chronological.first.createdAt),
    );
  }

  TaskEvent? pendingTool; // open PreToolUse awaiting its Post
  String?
  swallowPost; // tool whose Post row is dropped (plan/todo rendered from Pre)

  final indexedTools = <String, ({TaskEvent pre, int index})>{};
  final completedTools = <String>{};
  void emitTool(TaskEvent pre, {TaskEvent? post, bool active = false}) {
    final tool = pre.toolName ?? post?.toolName ?? 'Tool';
    final isEdit = _isEditTool(tool);
    final args = pre.toolInput ?? post?.toolInput ?? pre.detail ?? post?.detail;
    final stats = isEdit ? editStats(post?.detail) : null;
    out.add(
      ChatMessage(
        isEdit ? ChatKind.toolEdit : ChatKind.toolBash,
        id:
            pre.toolCallId ??
            pre.eventKey ??
            '${pre.hookEventName}:${pre.id}:${pre.createdAt}',
        turnId: pre.turnId ?? post?.turnId,
        toolName: tool,
        toolArgs: args,
        toolTitle: (args != null && args.isNotEmpty) ? '$tool · $args' : tool,
        toolOutput: post?.detail,
        ok: post?.hookEventName == 'PostToolUseFailure' ? false : post?.ok,
        active: active || post == null,
        createdAt: (post ?? pre).createdAt,
        addCount: stats?.$1,
        delCount: stats?.$2,
      ),
    );
  }

  void flushPending() {
    if (pendingTool != null) {
      emitTool(pendingTool!);
      pendingTool = null;
    }
  }

  for (final e in chronological) {
    if (e.toolCallId != null &&
        [
          'PreToolUse',
          'PostToolUse',
          'PostToolUseFailure',
          'ToolOutput',
        ].contains(e.hookEventName)) {
      flushPending();
      final existing = indexedTools[e.toolCallId];
      final started = e.hookEventName == 'PreToolUse';
      final completed =
          e.hookEventName == 'PostToolUse' ||
          e.hookEventName == 'PostToolUseFailure';
      if (!completed && completedTools.contains(e.toolCallId)) continue;
      if (completed) completedTools.add(e.toolCallId!);
      emitTool(
        existing?.pre ?? e,
        post: started ? null : e,
        active: e.hookEventName == 'ToolOutput',
      );
      if (existing == null) {
        indexedTools[e.toolCallId!] = (pre: e, index: out.length - 1);
      } else {
        out[existing.index] = out.removeLast();
      }
      continue;
    }
    switch (e.hookEventName) {
      case 'UserPromptSubmit':
        out.add(
          ChatMessage(
            ChatKind.userText,
            id: e.itemId ?? e.eventKey ?? 'user:${e.id}:${e.createdAt}',
            turnId: e.turnId,
            text: (e.detail?.isNotEmpty ?? false) ? e.detail : '用户指令',
            createdAt: e.createdAt,
          ),
        );
        break;
      case 'AssistantText':
        if (e.detail?.trim().isNotEmpty ?? false) {
          out.add(
            ChatMessage(
              e.phase == 'commentary'
                  ? ChatKind.commentary
                  : ChatKind.assistantText,
              id: e.itemId ?? e.eventKey ?? 'answer:${e.id}:${e.createdAt}',
              turnId: e.turnId,
              text: e.detail,
              createdAt: e.createdAt,
            ),
          );
        }
        break;
      case 'Thinking':
        if (e.detail?.trim().isNotEmpty ?? false) {
          out.add(
            ChatMessage(
              ChatKind.thinking,
              id: e.itemId ?? e.eventKey ?? 'thinking:${e.id}:${e.createdAt}',
              turnId: e.turnId,
              text: e.detail,
              createdAt: e.createdAt,
            ),
          );
        }
        break;
      case 'PreToolUse':
        // 📋 计划块：ExitPlanMode 的 plan 以 Markdown 呈现。
        if (e.toolName == 'ExitPlanMode') {
          flushPending();
          out.add(
            ChatMessage(ChatKind.plan, text: e.detail, createdAt: e.createdAt),
          );
          swallowPost = 'ExitPlanMode';
          break;
        }
        // TODO 卡：仅当 detail 里真的能解析出 todos 结构时渲染。
        if (e.toolName == 'TodoWrite') {
          final todos = tryParseTodos(e.detail);
          if (todos != null) {
            flushPending();
            out.add(
              ChatMessage(ChatKind.todo, todos: todos, createdAt: e.createdAt),
            );
            swallowPost = 'TodoWrite';
            break;
          }
        }
        if (pendingTool != null) {
          emitTool(pendingTool!); // previous never closed
        }
        pendingTool = e;
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (swallowPost != null && e.toolName == swallowPost) {
          swallowPost = null;
          break;
        }
        if (pendingTool != null && (pendingTool!.toolName == e.toolName)) {
          emitTool(pendingTool!, post: e);
          pendingTool = null;
        } else {
          emitTool(e, post: e);
        }
        break;
      case 'PermissionRequest':
        // Only show the tappable waiting capsule while the approval is still
        // pending; once resolved, the ApprovalResolved row renders the outcome.
        if (pendingApproval != null) {
          out.add(
            ChatMessage(
              ChatKind.capsuleWaiting,
              text: '等待审批：${e.detail ?? '需要批准'} · 点此处理',
              approvalId: pendingApproval.approvalId,
              createdAt: e.createdAt,
            ),
          );
        }
        break;
      case 'TaskStatus':
        flushPending();
        out.add(
          ChatMessage(
            ChatKind.capsuleInfo,
            text: e.detail ?? e.summary,
            createdAt: e.createdAt,
          ),
        );
        break;
      case 'ApprovalResolved':
        // Synthesized by the server on resolve (WS event.append) — renders the
        // green/red outcome capsule inline in the conversation.
        out.add(
          ChatMessage(
            e.status == 'rejected'
                ? ChatKind.capsuleRejected
                : ChatKind.capsuleApproved,
            text: e.summary ?? (e.status == 'rejected' ? '已拒绝' : '已批准'),
            createdAt: e.createdAt,
          ),
        );
        break;
      case 'Notification':
        if (e.status == 'needs_approval') {
          out.add(
            ChatMessage(
              ChatKind.capsuleWaiting,
              text: '等待审批 · 点此处理',
              approvalId: pendingApproval?.approvalId,
              createdAt: e.createdAt,
            ),
          );
        } else if (e.status == 'waiting_input') {
          out.add(
            ChatMessage(
              ChatKind.capsuleInfo,
              text: e.summary ?? '等待你的输入',
              createdAt: e.createdAt,
            ),
          );
        }
        break;
      case 'Stop':
        out.add(
          ChatMessage(
            ChatKind.capsuleInfo,
            text: '任务完成 ✓',
            createdAt: e.createdAt,
          ),
        );
        break;
      default:
        break;
    }
  }

  if (pendingTool != null) emitTool(pendingTool!); // still-running tool

  // Only the LAST TodoWrite checklist matters (it supersedes earlier ones).
  final lastTodo = out.lastIndexWhere((m) => m.kind == ChatKind.todo);
  if (lastTodo >= 0) {
    for (var i = out.length - 1; i >= 0; i--) {
      if (i != lastTodo && out[i].kind == ChatKind.todo) out.removeAt(i);
    }
  }

  // Ensure a tappable waiting capsule is present when an approval is pending.
  final hasWaiting = out.any((m) => m.kind == ChatKind.capsuleWaiting);
  if (pendingApproval != null && !hasWaiting) {
    out.add(
      ChatMessage(
        ChatKind.capsuleWaiting,
        text:
            '${pendingApproval.kind == 'input' ? '等待回复' : '等待审批'}：${pendingApproval.title} · 点此处理',
        approvalId: pendingApproval.approvalId,
        createdAt: pendingApproval.createdAt,
      ),
    );
  }
  return out;
}
