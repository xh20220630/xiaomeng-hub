import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../chat_builder.dart';
import '../conversation_presentation.dart';
import '../models.dart';
import '../services/ws_service.dart';
import '../state/history.dart';
import '../state/monitor.dart';
import '../theme/tokens.dart';
import 'approval_drawer.dart';
import 'activity_group.dart';
import 'chat_widgets.dart';

class ConversationTimeline extends ConsumerStatefulWidget {
  final Project project;
  final String sessionId;
  const ConversationTimeline({
    super.key,
    required this.project,
    required this.sessionId,
  });
  @override
  ConsumerState<ConversationTimeline> createState() =>
      _ConversationTimelineState();
}

class _ConversationTimelineState extends ConsumerState<ConversationTimeline> {
  final _scroll = ScrollController();
  List<TaskEvent>? _previousHistory;
  List<TaskEvent>? _previousLive;
  Approval? _previousApproval;
  String? _previousStreaming;
  String? _previousPending;
  List<ChatMessage> _messages = const [];
  bool _awayFromLatest = false;
  final _entryKeys = <String, GlobalKey>{};
  bool _restoringPosition = false;
  bool _historyCheckQueued = false;
  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
  }

  void _onScroll() {
    final away = _scroll.hasClients && _scroll.offset > 140;
    if (away != _awayFromLatest) setState(() => _awayFromLatest = away);
    _queueHistoryCheck();
  }

  void _queueHistoryCheck() {
    if (_historyCheckQueued) return;
    _historyCheckQueued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _historyCheckQueued = false;
      if (!mounted || !_scroll.hasClients) return;
      final history = ref.read(historyProvider(widget.sessionId));
      if (history.loading || history.error != null || history.cursor == null) {
        return;
      }
      // Reversed lists put older messages at the maximum scroll extent.
      if (_scroll.position.extentAfter < 180) {
        ref.read(historyProvider(widget.sessionId).notifier).loadMore();
      }
    });
  }

  void _preserveReadingPosition() {
    if (!_awayFromLatest || !_scroll.hasClients || _restoringPosition) return;
    final viewport = context.findRenderObject();
    if (viewport is! RenderBox || !viewport.hasSize) return;
    final top = viewport.localToGlobal(Offset.zero).dy;
    GlobalKey? anchor;
    double? before;
    for (final key in _entryKeys.values) {
      final box = key.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.hasSize || !box.attached) continue;
      final y = box.localToGlobal(Offset.zero).dy;
      if (y >= top && y < top + viewport.size.height) {
        anchor = key;
        before = y;
        break;
      }
    }
    if (anchor == null) return;
    final extent = _scroll.position.maxScrollExtent;
    _restoringPosition = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _restoringPosition = false;
      if (!mounted ||
          !_scroll.hasClients ||
          !_awayFromLatest ||
          _scroll.position.isScrollingNotifier.value) {
        return;
      }
      final box = anchor?.currentContext?.findRenderObject();
      // Keep the visible message in place when new content grows below it.
      final shift = box is RenderBox && box.hasSize && box.attached
          ? before! - box.localToGlobal(Offset.zero).dy
          : _scroll.position.maxScrollExtent - extent;
      if (shift.abs() > 1) {
        _scroll.jumpTo(
          (_scroll.offset + shift).clamp(0, _scroll.position.maxScrollExtent),
        );
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final sid = widget.sessionId;
    final history = ref.watch(historyProvider(sid));
    _queueHistoryCheck();
    final live = ref.watch(monitorProvider.select((s) => s.liveEvents[sid]));
    final streaming = ref.watch(
      monitorProvider.select((s) => s.streaming[sid]),
    );
    final streamInfo = ref.watch(
      monitorProvider.select(
        (s) => (
          s.streamingPhases[sid],
          s.streamingItems[sid],
          s.streamingTurns[sid],
        ),
      ),
    );
    final connected = ref.watch(
      monitorProvider.select((s) => s.status == WsStatus.connected),
    );
    final session = widget.project.sessions
        .where((s) => s.sessionId == sid)
        .firstOrNull;
    final running = streaming != null || session?.status == 'running';
    final pending = ref.watch(
      monitorProvider.select((s) => s.pendingUser[sid]),
    );
    final approval = widget.project.pendingApproval?.sessionId == sid
        ? widget.project.pendingApproval
        : null;
    final eventsChanged =
        !identical(_previousHistory, history.events) ||
        !identical(_previousLive, live) ||
        _previousApproval != approval;
    if (eventsChanged ||
        _previousStreaming != streaming ||
        _previousPending != pending) {
      _preserveReadingPosition();
    }
    _previousStreaming = streaming;
    _previousPending = pending;
    if (eventsChanged) {
      _previousHistory = history.events;
      _previousLive = live;
      _previousApproval = approval;
      _messages = buildChat(
        mergeConversationEvents(history.events, live ?? const []),
        pendingApproval: approval,
      );
    }
    final messages = [
      ...withStreamingReply(
        _messages,
        text: streaming,
        phase: streamInfo.$1,
        itemId: streamInfo.$2,
        turnId: streamInfo.$3,
      ),
    ];
    if (pending != null &&
        pending.isNotEmpty &&
        !_messages.any(
          (m) => m.kind == ChatKind.userText && m.text == pending,
        )) {
      messages.add(
        ChatMessage(ChatKind.userText, id: 'pending-user', text: pending),
      );
    }
    final entries = presentConversation(messages);
    if (running &&
        (entries.isEmpty || !entries.last.activity) &&
        (streaming == null || streaming.isEmpty)) {
      entries.add(const ConversationEntry('running', [], activity: true));
    }
    final entryIndices = {
      for (var i = 0; i < entries.length; i++)
        entries[i].id: entries.length - 1 - i,
    };
    _entryKeys.removeWhere((id, _) => !entryIndices.containsKey(id));

    if (history.loading && messages.isEmpty) {
      return const Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (entries.isEmpty && history.error == null && history.cursor == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Image.asset(
                'assets/mascot-v2/hero-welcome.png',
              width: 144,
              height: 144,
              cacheWidth: 320,
            ),
            const SizedBox(height: 16),
            Text(
              '从一个想法开始',
              style: AppFont.ui(size: 22, weight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            Text(
              '发一条消息，小梦陪你继续。',
              style: AppFont.ui(color: AppColors.textSecondary),
            ),
          ],
        ),
      );
    }
    return Column(
      children: [
        if (history.error != null)
          MaterialBanner(
            content: Text(history.error!, style: AppFont.ui(size: 12)),
            actions: [
              TextButton(
                onPressed: () {
                  final controller = ref.read(historyProvider(sid).notifier);
                  if (history.failedOlder) {
                    controller.loadMore();
                  } else {
                    controller.refresh();
                  }
                },
                child: const Text('重试'),
              ),
            ],
          ),
        Expanded(
          child: Stack(
            children: [
              ListView.builder(
                key: PageStorageKey('conversation:$sid'),
                controller: _scroll,
                reverse: true,
                padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
                itemCount: entries.length + 1,
                findChildIndexCallback: (key) =>
                    key is ValueKey<String> ? entryIndices[key.value] : null,
                itemBuilder: (context, index) {
                  if (index == entries.length) {
                    return Center(
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 20),
                        child: history.loadingOlder
                            ? Semantics(
                                label: '正在读取历史消息',
                                liveRegion: true,
                                child: SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 1.5,
                                  ),
                                ),
                              )
                            : Text(
                                history.loading
                                    ? '正在读取…'
                                    : history.cursor == null
                                    ? '会话的起点'
                                    : '',
                                style: AppFont.ui(
                                  size: 11,
                                  color: AppColors.textPlaceholder,
                                ),
                              ),
                      ),
                    );
                  }
                  final entry = entries[entries.length - index - 1];
                  final message = entry.messages.firstOrNull;
                  return RepaintBoundary(
                    key: ValueKey(entry.id),
                    child: Padding(
                      key: _entryKeys.putIfAbsent(entry.id, GlobalKey.new),
                      padding: const EdgeInsets.only(bottom: 22),
                      child: entry.activity
                          ? ActivityGroup(
                              messages: entry.messages,
                              running: running && index == 0,
                              offline: !connected || !widget.project.online,
                            )
                          : ChatBubble(
                              message!,
                              onWaitingTap:
                                  message.kind == ChatKind.capsuleWaiting &&
                                      approval != null
                                  ? () => showApprovalDrawer(
                                      context,
                                      ref,
                                      approval,
                                    )
                                  : null,
                            ),
                    ),
                  );
                },
              ),
              if (_awayFromLatest)
                Positioned(
                  bottom: 12,
                  left: 0,
                  right: 0,
                  child: Center(
                    child: FilledButton.tonalIcon(
                      style: FilledButton.styleFrom(
                        backgroundColor: AppColors.bg,
                        foregroundColor: AppColors.ink,
                        elevation: 3,
                        minimumSize: const Size(48, 44),
                        side: const BorderSide(color: AppColors.borderWarm),
                      ),
                      onPressed: () => _scroll.animateTo(
                        0,
                        duration: const Duration(milliseconds: 260),
                        curve: Curves.easeOutCubic,
                      ),
                      icon: const Icon(Icons.arrow_downward_rounded, size: 17),
                      label: const Text('回到最新'),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
