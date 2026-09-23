import 'package:flutter/material.dart';
import '../chat_builder.dart';
import '../conversation_presentation.dart';
import '../theme/tokens.dart';
import '../util.dart';
import 'markdown_text.dart';
import 'mascot.dart';
import 'activity_group.dart';
import 'copy_action.dart';

/// Renders a single [ChatMessage] in the F2 conversation. [onWaitingTap] fires
/// when the user taps the pending-approval capsule (capsuleWaiting).
class ChatBubble extends StatelessWidget {
  final ChatMessage message;
  final VoidCallback? onWaitingTap;

  const ChatBubble(this.message, {super.key, this.onWaitingTap});

  @override
  Widget build(BuildContext context) {
    switch (message.kind) {
      case ChatKind.timestamp:
        return _Timestamp(message.createdAt);
      case ChatKind.assistantText:
        return _AssistantText(message.text ?? '', active: message.active);
      case ChatKind.userText:
        return _UserText(message.text ?? '');
      case ChatKind.thinking:
      case ChatKind.commentary:
        return ActivityGroup(messages: [message], running: message.active);
      case ChatKind.toolBash:
      case ChatKind.toolEdit:
        return ActivityToolRow(message: message, running: message.active);
      case ChatKind.plan:
        return _PlanBlock(message.text);
      case ChatKind.todo:
        return _TodoCard(message.todos ?? const []);
      case ChatKind.capsuleWaiting:
        return _CapsuleWaiting(
          message.text ?? '等待审批 · 点此处理',
          onTap: onWaitingTap,
        );
      case ChatKind.capsuleApproved:
        return _Capsule(
          message.text ?? '✓ 已批准',
          fg: AppColors.success,
          bg: AppColors.greenLight,
        );
      case ChatKind.capsuleRejected:
        return _Capsule(
          message.text ?? '✕ 已拒绝',
          fg: AppColors.rejectCapsuleText,
          bg: AppColors.rejectCapsuleBg,
        );
      case ChatKind.capsuleInfo:
        return _Capsule(
          message.text ?? '',
          fg: AppColors.textSecondary,
          bg: AppColors.timestampBg,
        );
    }
  }
}

class _Timestamp extends StatelessWidget {
  final int? createdAt;
  const _Timestamp(this.createdAt);

  @override
  Widget build(BuildContext context) {
    final t = hms(createdAt);
    if (createdAt == null) return const SizedBox.shrink();
    final date = DateTime.fromMillisecondsSinceEpoch(createdAt!);
    final now = DateTime.now();
    final day =
        date.year == now.year && date.month == now.month && date.day == now.day
        ? '今天'
        : '${date.year}/${date.month}/${date.day}';
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 12),
        decoration: BoxDecoration(
          color: AppColors.timestampBg,
          borderRadius: BorderRadius.circular(AppRadii.timestamp),
        ),
        child: Text(
          '$day $t',
          style: AppFont.ui(
            size: 11,
            weight: FontWeight.w600,
            color: AppColors.textPlaceholder,
          ),
        ),
      ),
    );
  }
}

class _AssistantText extends StatefulWidget {
  final String text;
  final bool active;
  const _AssistantText(this.text, {this.active = false});
  @override
  State<_AssistantText> createState() => _AssistantTextState();
}

class _AssistantTextState extends State<_AssistantText> {
  bool _expanded = false;
  @override
  Widget build(BuildContext context) {
    final long = !widget.active && widget.text.length > 12000;
    final text = long && !_expanded
        ? '${widget.text.substring(0, 12000)}\n\n…'
        : widget.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const MascotImage(MascotMood.avatar, size: 34, circleBg: true),
            const SizedBox(width: 8),
            Text('小梦', style: AppFont.ui(size: 12, weight: FontWeight.w600)),
            if (widget.active)
              Padding(
                padding: const EdgeInsets.only(left: 9),
                child: Text(
                  '正在生成',
                  style: AppFont.ui(size: 11, color: AppColors.textSecondary),
                ),
              ),
          ],
        ),
        const SizedBox(height: 12),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: AppColors.card,
            borderRadius: BorderRadius.circular(AppRadii.card),
          ),
          child: SelectionArea(child: MarkdownText(text)),
        ),
        if (long)
          TextButton(
            onPressed: () => setState(() => _expanded = !_expanded),
            child: Text(_expanded ? '收起长回复' : '展开完整回复'),
          ),
        if (!widget.active)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: CopyAction(text: widget.text, label: '复制回复'),
          ),
      ],
    );
  }
}

class _UserText extends StatefulWidget {
  final String text;
  const _UserText(this.text);
  @override
  State<_UserText> createState() => _UserTextState();
}

class _UserTextState extends State<_UserText> {
  bool _expanded = false;
  @override
  Widget build(BuildContext context) {
    final content = presentUserMessage(widget.text);
    final long = content.text.length > 1400;
    final text = long && !_expanded
        ? '${content.text.substring(0, 1400)}…'
        : content.text;
    return Align(
      alignment: Alignment.centerRight,
      child: FractionallySizedBox(
        widthFactor: 0.86,
        child: Align(
          alignment: Alignment.centerRight,
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 13, horizontal: 18),
            decoration: BoxDecoration(
              color: AppColors.halo,
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(AppRadii.card),
                topRight: Radius.circular(AppRadii.card),
                bottomLeft: Radius.circular(AppRadii.card),
                bottomRight: Radius.circular(7),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (content.hasImage)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(
                          Icons.image_outlined,
                          size: 15,
                          color: AppColors.textSecondary,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          '附有图片',
                          style: AppFont.ui(
                            size: 12,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                Text(
                  text,
                  style: AppFont.ui(
                    size: 15,
                    color: AppColors.userBubbleText,
                    height: 1.65,
                  ),
                ),
                if (long)
                  TextButton(
                    onPressed: () => setState(() => _expanded = !_expanded),
                    child: Text(_expanded ? '收起' : '展开完整消息'),
                  ),
                if (content.hasContext)
                  TextButton(
                    onPressed: () => showActivityDetails(
                      context,
                      ChatMessage(ChatKind.userText, text: widget.text),
                    ),
                    child: Text(
                      '查看原始消息',
                      style: AppFont.ui(
                        size: 11,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Tappable pending-approval pill with an expanding ring pulse.
class _CapsuleWaiting extends StatefulWidget {
  final String text;
  final VoidCallback? onTap;
  const _CapsuleWaiting(this.text, {this.onTap});

  @override
  State<_CapsuleWaiting> createState() => _CapsuleWaitingState();
}

class _CapsuleWaitingState extends State<_CapsuleWaiting>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1800),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (kStaticCapture || MediaQuery.disableAnimationsOf(context)) {
      _ctrl.value = 1;
    } else if (_ctrl.status == AnimationStatus.dismissed) {
      _ctrl.forward();
    }
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final label = widget.text.startsWith('●')
        ? widget.text
        : '● ${widget.text}';
    return Center(
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedBuilder(
          animation: _ctrl,
          builder: (context, child) {
            final v = _ctrl.value;
            return Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(AppRadii.button),
                boxShadow: [
                  // static drop shadow
                  BoxShadow(
                    color: AppColors.primary.withValues(alpha: 0.34),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  ),
                  // expanding ring (0 -> 10px, fading out)
                  BoxShadow(
                    color: AppColors.primary.withValues(alpha: 0.5 * (1 - v)),
                    spreadRadius: 10 * v,
                    blurRadius: 0,
                  ),
                ],
              ),
              child: child,
            );
          },
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 16),
            decoration: BoxDecoration(
              color: AppColors.primary,
              borderRadius: BorderRadius.circular(AppRadii.button),
            ),
            child: Text(
              label,
              style: AppFont.ui(
                size: 13,
                weight: FontWeight.w700,
                color: Colors.white,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 📋 计划块（ExitPlanMode）：暖白卡 + 赭石描边，内容按 Markdown 渲染。
class _PlanBlock extends StatelessWidget {
  final String? text;
  const _PlanBlock(this.text);

  @override
  Widget build(BuildContext context) {
    final body = (text != null && text!.trim().isNotEmpty)
        ? text!.trim()
        : '（计划已提交，内容请在电脑端查看）';
    return Padding(
      padding: const EdgeInsets.only(left: 37),
      child: Align(
        alignment: Alignment.centerLeft,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.86,
          ),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(13, 11, 13, 12),
            decoration: BoxDecoration(
              color: AppColors.warmWhite,
              border: Border.all(color: AppColors.primary, width: 1.5),
              borderRadius: BorderRadius.circular(AppRadii.tool),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '📋 计划',
                  style: AppFont.ui(
                    size: 12.5,
                    weight: FontWeight.w800,
                    color: AppColors.primaryDeep,
                  ),
                ),
                const SizedBox(height: 7),
                MarkdownText(body, color: AppColors.bodySecondary, size: 12.5),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// TodoWrite 清单卡：✓ 已完成（划线）/ ▸ 进行中（高亮）/ ○ 待办。
class _TodoCard extends StatelessWidget {
  final List<TodoItem> todos;
  const _TodoCard(this.todos);

  @override
  Widget build(BuildContext context) {
    final done = todos.where((t) => t.status == 'completed').length;
    return Padding(
      padding: const EdgeInsets.only(left: 37),
      child: Align(
        alignment: Alignment.centerLeft,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.86,
          ),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(13, 11, 13, 12),
            decoration: BoxDecoration(
              color: AppColors.card,
              border: Border.all(color: AppColors.borderWarm, width: 1.5),
              borderRadius: BorderRadius.circular(AppRadii.tool),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    const Icon(
                      Icons.checklist,
                      size: 14,
                      color: AppColors.textSecondary,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      '待办清单',
                      style: AppFont.ui(
                        size: 12.5,
                        weight: FontWeight.w800,
                        color: AppColors.textSecondary,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      '$done/${todos.length}',
                      style: AppFont.ui(
                        size: 11.5,
                        weight: FontWeight.w700,
                        color: AppColors.textPlaceholder,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 7),
                for (final t in todos)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          switch (t.status) {
                            'completed' => '✓',
                            'in_progress' => '▸',
                            _ => '○',
                          },
                          style: AppFont.mono(
                            size: 12,
                            weight: FontWeight.w700,
                            color: switch (t.status) {
                              'completed' => AppColors.success,
                              'in_progress' => AppColors.primary,
                              _ => AppColors.textPlaceholder,
                            },
                          ),
                        ),
                        const SizedBox(width: 7),
                        Expanded(
                          child: Text(
                            t.text,
                            style:
                                AppFont.ui(
                                  size: 12.5,
                                  weight: t.status == 'in_progress'
                                      ? FontWeight.w800
                                      : FontWeight.w600,
                                  color: t.status == 'completed'
                                      ? AppColors.textPlaceholder
                                      : AppColors.bodySecondary,
                                  height: 1.4,
                                ).copyWith(
                                  decoration: t.status == 'completed'
                                      ? TextDecoration.lineThrough
                                      : TextDecoration.none,
                                ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Centered status capsule (approved / rejected / info).
class _Capsule extends StatelessWidget {
  final String text;
  final Color fg;
  final Color bg;
  const _Capsule(this.text, {required this.fg, required this.bg});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 14),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Text(
          text,
          style: AppFont.ui(size: 12, weight: FontWeight.w700, color: fg),
        ),
      ),
    );
  }
}
