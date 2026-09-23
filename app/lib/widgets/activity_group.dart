import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../chat_builder.dart';
import '../conversation_presentation.dart';
import '../theme/tokens.dart';
import 'markdown_text.dart';
import 'mascot.dart';

class ActivityGroup extends StatefulWidget {
  final List<ChatMessage> messages;
  final bool running;
  final bool offline;
  const ActivityGroup({
    super.key,
    required this.messages,
    this.running = false,
    this.offline = false,
  });
  @override
  State<ActivityGroup> createState() => _ActivityGroupState();
}

class _ActivityGroupState extends State<ActivityGroup> {
  bool _expanded = false;
  int _visible = 12;
  @override
  Widget build(BuildContext context) {
    final tools = widget.messages
        .where(
          (m) => m.kind == ChatKind.toolBash || m.kind == ChatKind.toolEdit,
        )
        .toList();
    final failures = tools.where((m) => m.ok == false).toList();
    final latest = widget.messages
        .where((m) => m.kind == ChatKind.commentary)
        .lastOrNull;
    final activeTool = tools.where((m) => m.active).lastOrNull;
    final running = widget.running && !widget.offline;
    final title = widget.offline && widget.running
        ? '连接中断，等待同步'
        : running
        ? '正在处理'
        : '执行记录';
    final preview = latest?.text?.trim();
    final rows = widget.messages.reversed
        .take(_visible)
        .toList()
        .reversed
        .toList();
    return Container(
      decoration: BoxDecoration(
        color: running ? AppColors.warmWhite : AppColors.card,
        border: Border.all(
          color: running ? AppColors.inputBorder : AppColors.borderWarm,
        ),
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: _expanded,
            label: '$title，${tools.length} 项操作',
            child: InkWell(
              borderRadius: BorderRadius.circular(18),
              onTap: () => setState(() => _expanded = !_expanded),
              child: Padding(
                padding: const EdgeInsets.all(15),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        if (running)
                          const MascotImage(MascotMood.running, size: 36)
                        else
                          Icon(
                            widget.offline && widget.running
                                ? Icons.wifi_off_rounded
                                : running
                                ? Icons.auto_awesome_outlined
                                : Icons.checklist_rounded,
                            size: 17,
                            color: AppColors.textSecondary,
                          ),
                        const SizedBox(width: 9),
                        Expanded(
                          child: Text(
                            title,
                            style: AppFont.ui(
                              size: 13,
                              weight: FontWeight.w600,
                            ),
                          ),
                        ),
                        Text(
                          '${tools.length} 项操作',
                          style: AppFont.ui(
                            size: 11,
                            color: AppColors.textSecondary,
                          ),
                        ),
                        const SizedBox(width: 8),
                        AnimatedRotation(
                          turns: _expanded ? .5 : 0,
                          duration: const Duration(milliseconds: 160),
                          child: const Icon(
                            Icons.keyboard_arrow_down,
                            size: 18,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ],
                    ),
                    if (running && preview?.isNotEmpty == true)
                      Padding(
                        padding: const EdgeInsets.only(top: 9),
                        child: Text(
                          preview!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: AppFont.ui(
                            size: 13,
                            color: AppColors.textSecondary,
                            height: 1.55,
                          ),
                        ),
                      ),
                    if (running && activeTool != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Row(
                          children: [
                            const Icon(
                              Icons.circle,
                              size: 5,
                              color: AppColors.success,
                            ),
                            const SizedBox(width: 7),
                            Expanded(
                              child: Text(
                                describeActivity(activeTool).title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppFont.ui(
                                  size: 12,
                                  color: AppColors.textSecondary,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    if (failures.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          '${failures.length} 项操作未成功 · ${describeActivity(failures.last).title}',
                          style: AppFont.ui(size: 12, color: AppColors.danger),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Divider(height: 1, color: AppColors.borderDivider),
                  if (widget.messages.length > _visible)
                    TextButton(
                      onPressed: () => setState(() => _visible += 20),
                      child: Text(
                        '显示更早的 ${widget.messages.length - _visible} 条记录',
                      ),
                    ),
                  for (final message in rows)
                    if (message.kind == ChatKind.commentary)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(9, 12, 9, 10),
                        child: MarkdownText(
                          message.text ?? '',
                          size: 13,
                          color: AppColors.textSecondary,
                        ),
                      )
                    else
                      ActivityToolRow(
                        message: message,
                        running: running && message.active,
                      ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class ActivityToolRow extends StatelessWidget {
  final ChatMessage message;
  final bool running;
  const ActivityToolRow({
    super.key,
    required this.message,
    this.running = false,
  });
  @override
  Widget build(BuildContext context) {
    final label = describeActivity(message);
    final failed = message.ok == false;
    final status = failed
        ? '未成功'
        : running
        ? '进行中'
        : message.active
        ? '未完成'
        : '查看';
    return InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () => showActivityDetails(context, message),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              failed
                  ? Icons.error_outline
                  : running
                  ? Icons.more_horiz
                  : message.kind == ChatKind.thinking
                  ? Icons.lightbulb_outline
                  : message.ok == true
                  ? Icons.check_rounded
                  : Icons.circle_outlined,
              size: 17,
              color: failed ? AppColors.danger : AppColors.textSecondary,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label.title,
                    style: AppFont.ui(size: 13, weight: FontWeight.w500),
                  ),
                  if (label.subject?.isNotEmpty == true)
                    Text(
                      label.subject!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppFont.mono(
                        size: 11,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  if (message.addCount != null || message.delCount != null)
                    Text(
                      '+${message.addCount ?? 0}  −${message.delCount ?? 0}',
                      style: AppFont.mono(size: 11, color: AppColors.success),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              status,
              style: AppFont.ui(
                size: 11,
                color: failed ? AppColors.danger : AppColors.textPlaceholder,
              ),
            ),
            const Icon(
              Icons.chevron_right_rounded,
              size: 16,
              color: AppColors.textPlaceholder,
            ),
          ],
        ),
      ),
    );
  }
}

Future<void> showActivityDetails(BuildContext context, ChatMessage message) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: AppColors.bg,
      builder: (context) => _ActivityDetails(message),
    );

class _ActivityDetails extends StatefulWidget {
  final ChatMessage message;
  const _ActivityDetails(this.message);
  @override
  State<_ActivityDetails> createState() => _ActivityDetailsState();
}

class _ActivityDetailsState extends State<_ActivityDetails> {
  bool _full = false;
  bool _input = false;
  bool _copied = false;
  @override
  Widget build(BuildContext context) {
    final message = widget.message, label = describeActivity(message);
    final input = message.toolArgs ?? '';
    final result = message.toolOutput ?? message.text ?? '';
    final separate = input.isNotEmpty && result.isNotEmpty && input != result;
    final text = _input || result.isEmpty ? input : result;
    final long = text.length > 12000;
    final shown = long && !_full ? '${text.substring(0, 12000)}\n…' : text;
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .82,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      label.title,
                      style: AppFont.ui(size: 19, weight: FontWeight.w600),
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭详情',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close, size: 21),
                  ),
                ],
              ),
              Text(
                '${label.category}${message.toolName == null ? '' : ' · ${message.toolName}'}',
                style: AppFont.ui(size: 12, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  if (separate) ...[
                    ChoiceChip(
                      label: const Text('输入'),
                      selected: _input,
                      onSelected: (_) => setState(() {
                        _input = true;
                        _full = false;
                        _copied = false;
                      }),
                    ),
                    const SizedBox(width: 8),
                    ChoiceChip(
                      label: const Text('结果'),
                      selected: !_input,
                      onSelected: (_) => setState(() {
                        _input = false;
                        _full = false;
                        _copied = false;
                      }),
                    ),
                  ] else
                    Text(
                      '原始记录',
                      style: AppFont.ui(
                        size: 12,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  const Spacer(),
                  TextButton.icon(
                    onPressed: text.isEmpty
                        ? null
                        : () async {
                            await Clipboard.setData(ClipboardData(text: text));
                            if (mounted) setState(() => _copied = true);
                          },
                    icon: Icon(
                      _copied ? Icons.check : Icons.copy_outlined,
                      size: 15,
                    ),
                    label: Text(_copied ? '已复制' : '复制'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Expanded(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: AppColors.warmWhite,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.all(14),
                    child: SelectionArea(
                      child: Text(
                        text.isEmpty
                            ? message.active
                                  ? '等待主机返回结果…'
                                  : '没有文本结果'
                            : shown,
                        style: AppFont.mono(
                          size: 12,
                          height: 1.65,
                          color: message.ok == false
                              ? AppColors.danger
                              : AppColors.bodySecondary,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (long)
                TextButton(
                  onPressed: () => setState(() => _full = !_full),
                  child: Text(_full ? '收起长记录' : '展开全部 ${text.length} 个字符'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
