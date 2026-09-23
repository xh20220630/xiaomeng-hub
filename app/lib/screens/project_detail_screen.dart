import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/monitor.dart';
import '../services/ws_service.dart';
import '../theme/tokens.dart';
import '../util.dart';
import '../widgets/mascot.dart';
import '../widgets/conversation_timeline.dart';
import '../widgets/agent_settings_sheet.dart';
import '../widgets/mascot_motion.dart';
import '../widgets/dream_motion.dart';

/// Opens a specific session while retaining the project's operation permissions.
///
/// [sessionId] optionally pins a specific session to open (e.g. tapping a
/// session row on the home page). When null, the project's active (latest)
/// session is shown. The top-bar ⋯ menu can switch sessions or start a new
/// one (POST /api/projects/:id/sessions).
class ProjectDetailScreen extends ConsumerStatefulWidget {
  final String projectId;
  final String? sessionId;
  final VoidCallback? onBack;
  const ProjectDetailScreen({
    super.key,
    required this.projectId,
    this.sessionId,
    this.onBack,
  });

  @override
  ConsumerState<ProjectDetailScreen> createState() =>
      _ProjectDetailScreenState();
}

class _ProjectDetailScreenState extends ConsumerState<ProjectDetailScreen> {
  final _input = TextEditingController();
  final _configuredModels = <String, ({String? previous, String current})>{};
  String? _sessionOverride; // set by 会话切换 / 新会话

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final project = ref.watch(projectProvider(widget.projectId));

    return Scaffold(
      backgroundColor: AppColors.bg,
      body: SafeArea(
        bottom: false,
        child: project == null ? _buildLoading() : _buildBody(context, project),
      ),
    );
  }

  Widget _buildLoading() {
    return const Center(
      child: SizedBox(
        width: 26,
        height: 26,
        child: CircularProgressIndicator(
          strokeWidth: 2.4,
          color: AppColors.primary,
        ),
      ),
    );
  }

  Widget _buildBody(BuildContext context, Project project) {
    // Session priority: user-switched > pinned by caller > project's active.
    final sessionId =
        _sessionOverride ?? widget.sessionId ?? project.activeSessionId;
    final selectedSession = project.sessions
        .where((s) => s.sessionId == sessionId)
        .firstOrNull;
    final configured = _configuredModels[sessionId];
    if (configured != null && selectedSession?.model != configured.previous) {
      _configuredModels.remove(sessionId);
    }
    final selectedModel =
        configured != null && selectedSession?.model == configured.previous
        ? configured.current
        : selectedSession?.model;
    final selectedStatus = sessionId == project.activeSessionId
        ? project.status
        : selectedSession?.status ?? project.status;
    final connected =
        ref.watch(monitorProvider.select((s) => s.status)) ==
        WsStatus.connected;

    final streaming = ref.watch(
      monitorProvider.select(
        (s) => sessionId == null ? null : s.streaming[sessionId],
      ),
    );
    final running = streaming != null || selectedStatus == 'running';
    final canSteer = project.canForSession(sessionId, 'message.steer');
    final canStop =
        connected &&
        sessionId != null &&
        project.canForSession(sessionId, 'session.stop');
    void stopSession() {
      if (sessionId != null) {
        ref.read(monitorProvider.notifier).sessionControl(sessionId, 'stop');
      }
    }

    // A failed message.send (assistant.done ok:false): restore the user's text
    // into the input box + show the error, then consume the record.
    if (sessionId != null) {
      ref.listen<FailedSend?>(
        monitorProvider.select((s) => s.failedSends[sessionId]),
        (prev, next) {
          if (next == null) return;
          if (next.text.isNotEmpty) {
            _input.text = next.text;
            _input.selection = TextSelection.collapsed(
              offset: _input.text.length,
            );
          }
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                (next.error != null && next.error!.isNotEmpty)
                    ? '发送失败：${next.error}'
                    : '发送失败，请重试',
              ),
            ),
          );
          Future.microtask(
            () => ref.read(monitorProvider.notifier).clearFailedSend(sessionId),
          );
        },
      );
    }

    return Column(
      children: [
        _TopBar(
          project: project,
          status: connected && project.online ? selectedStatus : 'offline',
          canCreate: connected && project.can('session.start'),
          currentSessionId: sessionId,
          onNewSession: () => _showNewSessionSheet(project),
          onSwitchSession: () => _showSessionSwitcher(project, sessionId),
          onBack: widget.onBack,
          onStop: running && canStop ? stopSession : null,
        ),
        Container(
          margin: const EdgeInsets.fromLTRB(18, 8, 18, 8),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          decoration: BoxDecoration(
            color: AppColors.halo,
            borderRadius: BorderRadius.circular(AppRadii.card),
          ),
          child: Row(
            children: [
              DreamActivityDot(
                active: running && connected && project.online,
                color: connected && project.online
                    ? AppColors.success
                    : AppColors.textPlaceholder,
              ),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  '${project.agentName} · ${project.nodeName}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppFont.ui(size: 11, color: AppColors.textSecondary),
                ),
              ),
              if (selectedSession?.archived == true)
                Text(
                  '已归档',
                  style: AppFont.ui(size: 11, color: AppColors.textSecondary),
                ),
              if (running)
                Text(
                  '正在执行',
                  style: AppFont.ui(size: 11, color: AppColors.success),
                ),
            ],
          ),
        ),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 820),
              child: sessionId == null
                  ? _EmptyConversation()
                  : ConversationTimeline(
                      key: ValueKey(sessionId),
                      project: project,
                      sessionId: sessionId,
                    ),
            ),
          ),
        ),
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 820),
            child: _InputBar(
              controller: _input,
              model:
                  selectedModel ??
                  (project.can('agent.catalog') ? '选择模型' : '主机默认模型'),
              onModelTap:
                  connected &&
                      selectedSession != null &&
                      project.can('agent.catalog')
                  ? () => showModalBottomSheet<void>(
                      context: context,
                      isScrollControlled: true,
                      showDragHandle: true,
                      backgroundColor: AppColors.card,
                      builder: (context) => AgentSettingsSheet(
                        api: ref.read(apiServiceProvider),
                        project: project,
                        session: selectedSession,
                        selectedModel: selectedModel,
                        onConfigured: (settings) {
                          final model = settings['model'];
                          if (mounted && model != null) {
                            setState(
                              () =>
                                  _configuredModels[selectedSession.sessionId] =
                                      (
                                        previous: selectedSession.model,
                                        current: model,
                                      ),
                            );
                          }
                        },
                      ),
                    )
                  : null,
              enabled:
                  connected &&
                  sessionId != null &&
                  project.canForSession(
                    sessionId,
                    running ? 'message.steer' : 'message.send',
                  ),
              streaming: running,
              canSteer: canSteer,
              canStop: canStop,
              agentName: project.agentName,
              disabledHint: !connected
                  ? '中心服务未连接'
                  : !project.online
                  ? 'Agent 离线'
                  : running && project.canForSession(sessionId, 'message.send')
                  ? '${project.agentName} 正在执行…'
                  : selectedSession?.controlReason ?? '此任务仅支持监控',
              onSend: (text) {
                if (sessionId == null) return false;
                final monitor = ref.read(monitorProvider.notifier);
                final ok = running
                    ? monitor.steerMessage(sessionId, text)
                    : monitor.sendMessage(sessionId, text);
                if (!ok) {
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(const SnackBar(content: Text('未连接，消息未发送')));
                }
                return ok;
              },
              onStop: stopSession,
            ),
          ),
        ),
      ],
    );
  }

  // ---- F-F 新会话：底部输入首条 prompt -> POST /api/projects/:id/sessions ----
  Future<void> _showNewSessionSheet(Project project) async {
    final controller = TextEditingController();
    var submitting = false;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.drawer,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppRadii.drawerTop),
        ),
      ),
      builder: (sheetCtx) => StatefulBuilder(
        builder: (sheetCtx, setSheetState) => SingleChildScrollView(
          child: Padding(
            padding: EdgeInsets.fromLTRB(
              22,
              18,
              22,
              22 + MediaQuery.of(sheetCtx).viewInsets.bottom,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '＋ 新会话 · ${project.name}',
                  style: AppFont.ui(
                    size: 16,
                    weight: FontWeight.w800,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: controller,
                  autofocus: true,
                  minLines: 2,
                  maxLines: 5,
                  style: AppFont.ui(
                    size: 13.5,
                    weight: FontWeight.w600,
                    color: AppColors.ink,
                  ),
                  cursorColor: AppColors.primary,
                  decoration: InputDecoration(
                    hintText: '输入第一条指令…',
                    hintStyle: AppFont.ui(
                      size: 13.5,
                      weight: FontWeight.w600,
                      color: AppColors.textPlaceholder,
                    ),
                    filled: true,
                    fillColor: AppColors.card,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(AppRadii.tool),
                      borderSide: const BorderSide(
                        color: AppColors.inputBorder,
                        width: 1.5,
                      ),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(AppRadii.tool),
                      borderSide: const BorderSide(
                        color: AppColors.inputBorder,
                        width: 1.5,
                      ),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(AppRadii.tool),
                      borderSide: const BorderSide(
                        color: AppColors.primary,
                        width: 1.5,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    minimumSize: const Size.fromHeight(48),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(AppRadii.button),
                    ),
                  ),
                  onPressed: submitting
                      ? null
                      : () async {
                          final text = controller.text.trim();
                          if (text.isEmpty) return;
                          setSheetState(() => submitting = true);
                          final sid = await ref
                              .read(apiServiceProvider)
                              .createSession(project.projectId, text);
                          if (!sheetCtx.mounted) return;
                          if (sid == null) {
                            setSheetState(() => submitting = false);
                            ScaffoldMessenger.of(sheetCtx).showSnackBar(
                              const SnackBar(content: Text('创建会话失败，请检查连接')),
                            );
                            return;
                          }
                          // Optimistic first bubble + streaming placeholder; the
                          // assistant.delta broadcast fills in the reply.
                          ref
                              .read(monitorProvider.notifier)
                              .primeNewSession(sid, text);
                          Navigator.of(sheetCtx).pop();
                          if (mounted) setState(() => _sessionOverride = sid);
                        },
                  child: submitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : Text(
                          '发送并开始',
                          style: AppFont.ui(
                            size: 15,
                            weight: FontWeight.w800,
                            color: Colors.white,
                          ),
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    // Dispose after the sheet's exit animation so the TextField never touches
    // a disposed controller during the closing frames.
    Future.delayed(const Duration(milliseconds: 400), controller.dispose);
  }

  // ---- 顶部会话切换：列出项目下真实会话 ----
  Future<void> _showSessionSwitcher(
    Project project,
    String? currentSessionId,
  ) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.drawer,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(AppRadii.drawerTop),
        ),
      ),
      builder: (sheetCtx) {
        final sessions = project.sessions;
        return SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 14, 10, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '切换会话',
                  style: AppFont.ui(
                    size: 15,
                    weight: FontWeight.w800,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: 6),
                if (sessions.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(18),
                    child: Text(
                      '暂无其他会话',
                      style: AppFont.ui(
                        size: 13,
                        weight: FontWeight.w600,
                        color: AppColors.textPlaceholder,
                      ),
                    ),
                  )
                else
                  Flexible(
                    child: ListView.builder(
                      shrinkWrap: true,
                      itemCount: sessions.length,
                      itemBuilder: (_, i) {
                        final s = sessions[i];
                        final active = s.sessionId == currentSessionId;
                        return ListTile(
                          dense: true,
                          onTap: () => Navigator.of(sheetCtx).pop(s.sessionId),
                          leading: Icon(
                            active
                                ? Icons.radio_button_checked
                                : Icons.radio_button_off,
                            size: 18,
                            color: active
                                ? AppColors.primary
                                : AppColors.textPlaceholder,
                          ),
                          title: Text(
                            (s.summary != null && s.summary!.isNotEmpty)
                                ? s.summary!
                                : '未命名会话',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppFont.ui(
                              size: 13,
                              weight: active
                                  ? FontWeight.w800
                                  : FontWeight.w600,
                              color: active
                                  ? AppColors.ink
                                  : AppColors.doneNameGray,
                            ),
                          ),
                          trailing: Text(
                            timeAgo(s.updatedAt),
                            style: AppFont.ui(
                              size: 11,
                              weight: FontWeight.w600,
                              color: AppColors.textPlaceholder,
                            ),
                          ),
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
    if (picked != null && mounted) setState(() => _sessionOverride = picked);
  }
}

/// Top bar: back / mascot / project name + status subtitle / ⋯ menu
/// (＋ 新会话、切换会话).
class _TopBar extends StatelessWidget {
  final Project project;
  final String status;
  final bool canCreate;
  final String? currentSessionId;
  final VoidCallback onNewSession;
  final VoidCallback onSwitchSession;
  final VoidCallback? onBack;
  final VoidCallback? onStop;
  const _TopBar({
    required this.project,
    required this.status,
    required this.canCreate,
    required this.currentSessionId,
    required this.onNewSession,
    required this.onSwitchSession,
    this.onBack,
    this.onStop,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 10, 14, 12),
      decoration: const BoxDecoration(
        color: AppColors.bg,
        border: Border(bottom: BorderSide(color: AppColors.borderDivider)),
      ),
      child: Row(
        children: [
          IconButton(
            tooltip: '返回会话列表',
            onPressed: onBack ?? () => Navigator.of(context).maybePop(),
            icon: const Icon(Icons.arrow_back_rounded, size: 21),
          ),
          const SizedBox(width: 5),
          MascotImage.forStatus(status, size: 44, circleBg: true, floaty: true),
          const SizedBox(width: 11),
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onSwitchSession, // 标题区域点按 = 快速切换会话
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    project.sessions
                            .where((s) => s.sessionId == currentSessionId)
                            .firstOrNull
                            ?.summary ??
                        project.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppFont.ui(
                      size: 15,
                      weight: FontWeight.w700,
                      color: AppColors.ink,
                    ),
                  ),
                  const SizedBox(height: 1),
                  Text(
                    project.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppFont.ui(
                      size: 12,
                      weight: FontWeight.w600,
                      color: AppColors.primaryDeep,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 4),
          PopupMenuButton<String>(
            tooltip: '会话操作',
            color: AppColors.card,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
            onSelected: (v) {
              if (v == 'new') onNewSession();
              if (v == 'switch') onSwitchSession();
              if (v == 'stop') onStop?.call();
            },
            itemBuilder: (_) => [
              if (onStop != null)
                const PopupMenuItem(value: 'stop', child: Text('停止当前任务')),
              PopupMenuItem(
                value: 'new',
                enabled: canCreate,
                child: Text(
                  '＋ 新会话',
                  style: AppFont.ui(
                    size: 13.5,
                    weight: FontWeight.w700,
                    color: AppColors.ink,
                  ),
                ),
              ),
              PopupMenuItem(
                value: 'switch',
                child: Text(
                  '切换会话',
                  style: AppFont.ui(
                    size: 13.5,
                    weight: FontWeight.w700,
                    color: AppColors.ink,
                  ),
                ),
              ),
            ],
            child: const Padding(
              padding: EdgeInsets.all(12),
              child: Icon(
                Icons.more_horiz_rounded,
                size: 24,
                color: AppColors.textSecondary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyConversation extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const MascotImage(MascotMood.main, size: 150, floaty: true),
          const SizedBox(height: 20),
          Text('小梦准备好了。', style: AppFont.ui(size: 23, weight: FontWeight.w600)),
          const SizedBox(height: 10),
          Text(
            '还没有对话记录',
            style: AppFont.ui(size: 13, color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }
}

/// The draft is cleared only after [onSend] hands the message to the socket.
class _InputBar extends StatefulWidget {
  final TextEditingController controller;
  final bool enabled;
  final bool streaming;
  final bool canStop;
  final bool canSteer;
  final String agentName;
  final String model;
  final VoidCallback? onModelTap;
  final String disabledHint;
  final bool Function(String text) onSend;
  final VoidCallback onStop;
  const _InputBar({
    required this.controller,
    required this.enabled,
    required this.streaming,
    required this.canStop,
    required this.canSteer,
    required this.agentName,
    required this.model,
    this.onModelTap,
    required this.disabledHint,
    required this.onSend,
    required this.onStop,
  });

  @override
  State<_InputBar> createState() => _InputBarState();
}

class _InputBarState extends State<_InputBar> {
  void _submit() {
    final text = widget.controller.text.trim();
    if (text.isEmpty ||
        !widget.enabled ||
        (widget.streaming && !widget.canSteer)) {
      return;
    }
    if (widget.onSend(text)) widget.controller.clear();
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(
      18,
      8,
      18,
      12 + MediaQuery.paddingOf(context).bottom,
    ),
    child: AnimatedContainer(
      duration: const Duration(milliseconds: 180),
      padding: const EdgeInsets.fromLTRB(16, 10, 8, 8),
      decoration: BoxDecoration(
        color: AppColors.card,
        border: Border.all(color: AppColors.inputBorder),
        borderRadius: BorderRadius.circular(AppRadii.card),
        boxShadow: [
          BoxShadow(
            color: AppColors.ink.withValues(alpha: .05),
            blurRadius: 24,
            offset: const Offset(0, 5),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 4, right: 12),
            child: TextField(
              controller: widget.controller,
              enabled: widget.enabled,
              minLines: 1,
              maxLines: 6,
              textInputAction: TextInputAction.newline,
              style: AppFont.ui(size: 15, height: 1.5),
              decoration: InputDecoration(
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                filled: false,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 8),
                hintText: !widget.enabled
                    ? widget.disabledHint
                    : widget.streaming
                    ? '追加指令，调整当前任务…'
                    : '发消息给 ${widget.agentName}',
                hintStyle: AppFont.ui(
                  size: 14,
                  color: AppColors.textPlaceholder,
                ),
              ),
            ),
          ),
          Row(
            children: [
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Tooltip(
                    message: '切换模型',
                    child: TextButton(
                      key: const ValueKey('composer-model'),
                      style: TextButton.styleFrom(
                        foregroundColor: AppColors.textSecondary,
                        backgroundColor: AppColors.card,
                        minimumSize: const Size(44, 44),
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                      ),
                      onPressed: widget.onModelTap,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Flexible(
                            child: Text(
                              widget.model,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppFont.ui(
                                size: 12,
                                weight: FontWeight.w500,
                                color: AppColors.textSecondary,
                              ),
                            ),
                          ),
                          const SizedBox(width: 4),
                          if (widget.onModelTap != null)
                            const Icon(
                              Icons.keyboard_arrow_down_rounded,
                              size: 17,
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              ValueListenableBuilder<TextEditingValue>(
                valueListenable: widget.controller,
                builder: (context, value, _) {
                  final hasText = value.text.trim().isNotEmpty;
                  final stop =
                      widget.streaming &&
                      widget.canStop &&
                      (!hasText || !widget.canSteer || !widget.enabled);
                  if (widget.streaming && !widget.canSteer && !stop) {
                    return const SizedBox.shrink();
                  }
                  return MotionPress(
                    child: IconButton.filled(
                      key: const ValueKey('composer-action'),
                      tooltip: stop
                          ? '停止任务'
                          : widget.streaming
                          ? '追加指令'
                          : '发送消息',
                      onPressed: stop
                          ? widget.onStop
                          : widget.enabled && hasText
                          ? _submit
                          : null,
                      icon: Icon(
                        stop ? Icons.stop_rounded : Icons.arrow_upward_rounded,
                        size: 20,
                      ),
                      style: IconButton.styleFrom(
                        backgroundColor: stop
                            ? AppColors.night
                            : AppColors.lime,
                        foregroundColor: stop
                            ? AppColors.onNight
                            : AppColors.ink,
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
        ],
      ),
    ),
  );
}
