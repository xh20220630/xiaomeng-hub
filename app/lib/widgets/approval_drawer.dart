import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../services/ws_service.dart';
import '../state/monitor.dart';
import '../theme/tokens.dart';
import '../util.dart';
import 'mascot.dart';

/// F3 审批抽屉。从对话底部弹出、背景压暗。
///
/// - command：危险命令醒目警告 + 拒绝 / 批准并执行二选一 + 「始终允许此类命令」复选。
/// - file_edit：先看 diff，再用单选给「仅本次 / 始终允许此文件 / 拒绝」三档。
///
/// 若该审批在打开期间被其他设备处理（从 monitorProvider.approvals 移除），
/// 自动 pop 并提示；若已过期，按钮禁用并提示回电脑处理。
Future<void> showApprovalDrawer(
  BuildContext context,
  WidgetRef ref,
  Approval a,
) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: false,
    constraints: const BoxConstraints(maxWidth: 640),
    barrierColor: AppColors.scrim,
    backgroundColor: Colors.transparent,
    builder: (_) => _ApprovalSheet(approval: a),
  );
}

class _ApprovalSheet extends ConsumerStatefulWidget {
  final Approval approval;
  const _ApprovalSheet({required this.approval});

  @override
  ConsumerState<_ApprovalSheet> createState() => _ApprovalSheetState();
}

/// file_edit 三档单选。
enum _FileChoice { once, always, reject }

class _ApprovalSheetState extends ConsumerState<_ApprovalSheet> {
  // command：始终允许此类命令。
  bool _alwaysChecked = false;
  // file_edit：默认选「仅本次允许此修改」。
  _FileChoice _fileChoice = _FileChoice.once;
  // 防止 resolved 自动 pop 与按钮 pop 重复触发。
  bool _busy = false;
  // 到达 expiresAt 时刻触发一次重建，让按钮实时变为禁用。
  Timer? _expiryTimer;
  final Map<String, TextEditingController> _answers = {};

  Approval get _a => widget.approval;

  @override
  void initState() {
    super.initState();
    for (final q in _a.questions) {
      _answers[q.id] = TextEditingController();
    }
    final exp = widget.approval.expiresAt;
    if (exp != null) {
      final left = exp - DateTime.now().millisecondsSinceEpoch;
      if (left > 0) {
        _expiryTimer = Timer(Duration(milliseconds: left + 250), () {
          if (mounted) setState(() {});
        });
      }
    }
  }

  @override
  void dispose() {
    _expiryTimer?.cancel();
    for (final controller in _answers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  void _showSnack(String text) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _respond({required bool approve, required String scope}) async {
    if (_busy) return;
    if (approve &&
        _a.kind == 'input' &&
        _answers.values.any((c) => c.text.trim().isEmpty)) {
      _showSnack('请回答所有问题');
      return;
    }
    setState(() => _busy = true);
    final sent = await ref
        .read(monitorProvider.notifier)
        .respondApproval(
          _a.approvalId,
          approve: approve,
          scope: scope,
          answers: _a.kind == 'input'
              ? _answers.map(
                  (id, controller) => MapEntry(id, controller.text.trim()),
                )
              : null,
        );
    if (!mounted) return;
    if (!sent) {
      setState(() => _busy = false);
      _showSnack('审批未发送，请检查连接及 Agent 状态');
      return;
    }
    Navigator.of(context).pop();
  }

  /// 抽屉打开期间从 monitorProvider 找到对应项目名（用于副标题）。
  String _projectName() {
    final projects = ref.read(monitorProvider).projects;
    for (final p in projects) {
      if (_a.projectId != null && p.projectId == _a.projectId) {
        return p.name.isNotEmpty
            ? p.name
            : (projectNameFromCwd(p.cwd) ?? p.projectId);
      }
      if (p.activeSessionId != null && p.activeSessionId == _a.sessionId) {
        return p.name.isNotEmpty
            ? p.name
            : (projectNameFromCwd(p.cwd) ?? p.projectId);
      }
    }
    return _a.projectId ?? '项目';
  }

  @override
  Widget build(BuildContext context) {
    // 监听 approvals：若该审批已不在其中（被他端处理/resolved）→ 自动 pop + 提示。
    ref.listen<MonitorState>(monitorProvider, (prev, next) {
      if (_busy) return;
      final stillPending = next.approvals.containsKey(_a.approvalId);
      if (!stillPending && mounted) {
        _busy = true;
        Navigator.of(context).pop();
        _showSnack('已在其他设备处理');
      }
    });

    final expired = _a.isExpired;
    // 需求13：WS 断开时禁用审批操作（REST 回退也大概率不可达，避免假确认）。
    final monitor = ref.watch(monitorProvider);
    final project = monitor.projects
        .where(
          (p) =>
              p.projectId == _a.projectId || p.activeSessionId == _a.sessionId,
        )
        .firstOrNull;
    final offline =
        monitor.status != WsStatus.connected ||
        (project != null && !project.can('approval.respond'));

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Container(
        width: double.infinity,
        decoration: const BoxDecoration(
          color: AppColors.drawer,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(AppRadii.drawerTop),
            topRight: Radius.circular(AppRadii.drawerTop),
          ),
          boxShadow: [
            BoxShadow(
              color: Color(0x42000000), // 0 -12 36 rgba(0,0,0,.26)
              blurRadius: 36,
              offset: Offset(0, -12),
            ),
          ],
        ),
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(22, 14, 22, 30),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // 顶部抓手 48x5。
                Center(
                  child: Container(
                    width: 48,
                    height: 5,
                    margin: const EdgeInsets.only(bottom: 18),
                    decoration: BoxDecoration(
                      color: AppColors.borderWarm,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
                if (_a.kind == 'input')
                  ..._buildQuestions(expired, offline)
                else if (_a.kind == 'file_edit')
                  ..._buildFileEdit(expired, offline)
                else
                  ..._buildCommand(expired, offline),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _buildQuestions(bool expired, bool offline) {
    final enabled = !expired && !offline && !_busy;
    return [
      Text(
        _a.title,
        style: AppFont.ui(
          size: 19,
          weight: FontWeight.w800,
          color: AppColors.ink,
        ),
      ),
      const SizedBox(height: 8),
      Text(
        _projectName(),
        style: AppFont.ui(size: 13, color: AppColors.textSecondary),
      ),
      for (final q in _a.questions) ...[
        const SizedBox(height: 20),
        Text(
          q.question,
          style: AppFont.ui(
            size: 15,
            weight: FontWeight.w600,
            color: AppColors.ink,
          ),
        ),
        for (final option in q.options)
          Material(
            color: Colors.transparent,
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(option.label),
              subtitle: option.description.isEmpty
                  ? null
                  : Text(option.description),
              leading: Icon(
                _answers[q.id]!.text == option.label
                    ? Icons.radio_button_checked
                    : Icons.radio_button_off,
              ),
              onTap: enabled
                  ? () => setState(() => _answers[q.id]!.text = option.label)
                  : null,
            ),
          ),
        TextField(
          controller: _answers[q.id],
          enabled: enabled,
          obscureText: q.isSecret,
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(hintText: '输入回复，也可以选择上面的选项'),
        ),
      ],
      const SizedBox(height: 20),
      if (expired || offline) Text(expired ? '请求已过期' : '主机未连接，暂时无法回复'),
      FilledButton(
        onPressed: enabled
            ? () => _respond(approve: true, scope: 'once')
            : null,
        child: Text(_busy ? '正在发送…' : '发送回复'),
      ),
      TextButton(
        onPressed: enabled
            ? () => _respond(approve: false, scope: 'once')
            : null,
        child: const Text('取消回复'),
      ),
    ];
  }

  // ---------------------------------------------------------------------------
  // command 变体
  // ---------------------------------------------------------------------------
  List<Widget> _buildCommand(bool expired, bool offline) {
    final enabled = !expired && !offline && !_busy;
    final cmd = _a.command ?? '';
    return [
      // 头：大形象 + 标题/副标题。
      Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          const MascotImage(MascotMood.approval, size: 58, floaty: true),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '小梦需要你批准',
                  style: AppFont.ui(
                    size: 19,
                    weight: FontWeight.w800,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: 1),
                Text(
                  '${_projectName()} · 执行命令',
                  style: AppFont.ui(
                    size: 13,
                    weight: FontWeight.w600,
                    color: AppColors.textSecondaryLight,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      const SizedBox(height: 17),
      // 代码块。
      Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
        decoration: BoxDecoration(
          color: AppColors.codeBg,
          borderRadius: BorderRadius.circular(AppRadii.codeBlock),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '# Bash',
              style: AppFont.mono(
                size: 11,
                weight: FontWeight.w400,
                color: AppColors.textSecondaryLight,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              cmd,
              style: AppFont.mono(
                size: 14,
                weight: FontWeight.w700,
                color: AppColors.codeHighlight,
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 14),
      // 危险警告条。
      if (_a.isDanger) ...[
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
          decoration: BoxDecoration(
            color: AppColors.warnBarBg,
            borderRadius: BorderRadius.circular(AppRadii.tool),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '⚠',
                style: AppFont.ui(
                  size: 15,
                  weight: FontWeight.w700,
                  color: AppColors.primary,
                  height: 1.3,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '危险操作：此命令可能造成不可撤销的更改，请确认后再批准。',
                  style: AppFont.ui(
                    size: 13,
                    weight: FontWeight.w600,
                    color: AppColors.primaryDeep,
                    height: 1.45,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
      ] else
        const SizedBox(height: 6),
      // 过期 / 离线提示。
      if (expired) ...[
        Text(
          '已过期，请回电脑处理',
          textAlign: TextAlign.center,
          style: AppFont.ui(
            size: 13,
            weight: FontWeight.w600,
            color: AppColors.textSecondaryLight,
          ),
        ),
        const SizedBox(height: 12),
      ] else if (offline) ...[
        Text(
          '未连接，无法操作审批',
          textAlign: TextAlign.center,
          style: AppFont.ui(
            size: 13,
            weight: FontWeight.w600,
            color: AppColors.danger,
          ),
        ),
        const SizedBox(height: 12),
      ],
      // 按钮行：拒绝 / 批准并执行。
      Row(
        children: [
          Expanded(
            flex: 10,
            child: _OutlineButton(
              label: '拒绝',
              enabled: enabled,
              onTap: () => _respond(
                approve: false,
                scope: _alwaysChecked ? 'always' : 'once',
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 13,
            child: _FilledButton(
              label: '批准并执行',
              enabled: enabled,
              onTap: () => _respond(
                approve: true,
                scope: _alwaysChecked ? 'always' : 'once',
              ),
            ),
          ),
        ],
      ),
      const SizedBox(height: 15),
      // 复选：本次会话内始终允许此类命令。
      if (_a.options.contains('always'))
        _CheckRow(
          checked: _alwaysChecked,
          label: '本次会话内始终允许此类命令',
          onTap: !enabled
              ? null
              : () => setState(() => _alwaysChecked = !_alwaysChecked),
        ),
    ];
  }

  // ---------------------------------------------------------------------------
  // file_edit 变体
  // ---------------------------------------------------------------------------
  List<Widget> _buildFileEdit(bool expired, bool offline) {
    final enabled = !expired && !offline && !_busy;
    return [
      // 头：小形象 + 标题。
      Row(
        children: [
          const MascotImage(MascotMood.approval, size: 38),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '修改文件待批准',
              style: AppFont.ui(
                size: 16,
                weight: FontWeight.w700,
                color: AppColors.ink,
              ),
            ),
          ),
        ],
      ),
      const SizedBox(height: 13),
      // 路径。
      Text(
        '✎ ${_a.filePath ?? ''}',
        style: AppFont.mono(
          size: 12,
          weight: FontWeight.w400,
          color: AppColors.doneNameGray,
        ),
      ),
      const SizedBox(height: 8),
      // diff 块。
      _DiffBlock(diff: _a.diff ?? ''),
      const SizedBox(height: 15),
      // 三档单选。
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _RadioRow(
            selected: _fileChoice == _FileChoice.once,
            label: '仅本次允许此修改',
            onTap: !enabled
                ? null
                : () => setState(() => _fileChoice = _FileChoice.once),
          ),
          const SizedBox(height: 11),
          if (_a.options.contains('always'))
            _RadioRow(
              selected: _fileChoice == _FileChoice.always,
              label: '始终允许编辑此文件',
              onTap: !enabled
                  ? null
                  : () => setState(() => _fileChoice = _FileChoice.always),
            ),
          const SizedBox(height: 11),
          _RadioRow(
            selected: _fileChoice == _FileChoice.reject,
            label: '拒绝此次修改',
            onTap: !enabled
                ? null
                : () => setState(() => _fileChoice = _FileChoice.reject),
          ),
        ],
      ),
      const SizedBox(height: 16),
      // 过期 / 离线提示。
      if (expired) ...[
        Text(
          '已过期，请回电脑处理',
          textAlign: TextAlign.center,
          style: AppFont.ui(
            size: 13,
            weight: FontWeight.w600,
            color: AppColors.textSecondaryLight,
          ),
        ),
        const SizedBox(height: 12),
      ] else if (offline) ...[
        Text(
          '未连接，无法操作审批',
          textAlign: TextAlign.center,
          style: AppFont.ui(
            size: 13,
            weight: FontWeight.w600,
            color: AppColors.danger,
          ),
        ),
        const SizedBox(height: 12),
      ],
      // 满宽确认按钮。
      _FilledButton(
        label: '确认',
        height: 50,
        radius: 15,
        fontSize: 15,
        enabled: enabled,
        onTap: () {
          switch (_fileChoice) {
            case _FileChoice.once:
              _respond(approve: true, scope: 'once');
              break;
            case _FileChoice.always:
              _respond(approve: true, scope: 'always');
              break;
            case _FileChoice.reject:
              _respond(approve: false, scope: 'once');
              break;
          }
        },
      ),
    ];
  }
}

// =============================================================================
// 子组件
// =============================================================================

/// 边框按钮（拒绝）。
class _OutlineButton extends StatelessWidget {
  final String label;
  final bool enabled;
  final VoidCallback onTap;
  const _OutlineButton({
    required this.label,
    required this.enabled,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) => OutlinedButton(
    onPressed: enabled ? onTap : null,
    style: OutlinedButton.styleFrom(
      foregroundColor: AppColors.ink,
      minimumSize: const Size(0, 54),
      side: const BorderSide(color: AppColors.borderWarm),
      shape: const StadiumBorder(),
      textStyle: AppFont.ui(size: 15, weight: FontWeight.w600),
    ),
    child: Text(label),
  );
}

/// 实心主按钮（批准并执行 / 确认）。
class _FilledButton extends StatelessWidget {
  final String label;
  final bool enabled;
  final VoidCallback onTap;
  final double height;
  final double radius;
  final double fontSize;
  const _FilledButton({
    required this.label,
    required this.enabled,
    required this.onTap,
    this.height = 54,
    this.radius = AppRadii.button,
    this.fontSize = 15,
  });

  @override
  Widget build(BuildContext context) => FilledButton(
    onPressed: enabled ? onTap : null,
    style: FilledButton.styleFrom(
      backgroundColor: AppColors.lime,
      foregroundColor: AppColors.ink,
      minimumSize: Size(0, height),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radius),
      ),
      textStyle: AppFont.ui(size: fontSize, weight: FontWeight.w600),
    ),
    child: Text(label),
  );
}

/// 复选行（command：始终允许此类命令）。
class _CheckRow extends StatelessWidget {
  final bool checked;
  final String label;
  final VoidCallback? onTap;
  const _CheckRow({
    required this.checked,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 19,
            height: 19,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: checked ? AppColors.primary : Colors.transparent,
              border: Border.all(
                color: checked ? AppColors.primary : AppColors.checkboxBorder,
                width: 2,
              ),
              borderRadius: BorderRadius.circular(5),
            ),
            child: checked
                ? const Icon(Icons.check, size: 13, color: Colors.white)
                : const SizedBox.shrink(),
          ),
          const SizedBox(width: 9),
          Text(
            label,
            style: AppFont.ui(
              size: 13,
              weight: FontWeight.w600,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

/// 单选行（file_edit 三档）。
class _RadioRow extends StatelessWidget {
  final bool selected;
  final String label;
  final VoidCallback? onTap;
  const _RadioRow({
    required this.selected,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Row(
        children: [
          Container(
            width: 19,
            height: 19,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                color: selected
                    ? AppColors.primary
                    : AppColors.stepDashedBorder,
                width: 2,
              ),
            ),
            child: selected
                ? Container(
                    width: 9,
                    height: 9,
                    decoration: const BoxDecoration(
                      color: AppColors.primary,
                      shape: BoxShape.circle,
                    ),
                  )
                : const SizedBox.shrink(),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              label,
              style: AppFont.ui(
                size: 14,
                weight: FontWeight.w400,
                color: selected ? AppColors.ink : AppColors.doneNameGray,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// diff 块：按行解析 unified diff（+绿 −红、等宽字体），默认折叠 12 行，
/// 可展开查看完整 diff。
class _DiffBlock extends StatefulWidget {
  final String diff;
  const _DiffBlock({required this.diff});

  @override
  State<_DiffBlock> createState() => _DiffBlockState();
}

class _DiffBlockState extends State<_DiffBlock> {
  static const _collapsedMax = 12;
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final all = widget.diff.split('\n');
    final canExpand = all.length > _collapsedMax;
    final lines = (_expanded || !canExpand)
        ? all
        : all.take(_collapsedMax).toList();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: AppColors.codeBg,
        borderRadius: BorderRadius.circular(AppRadii.tool),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final line in lines) _diffLine(line),
          if (canExpand)
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => setState(() => _expanded = !_expanded),
              child: Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  _expanded
                      ? '收起 ▴'
                      : '查看完整 diff（还有 ${all.length - _collapsedMax} 行）▾',
                  style: AppFont.mono(
                    size: 11.5,
                    weight: FontWeight.w700,
                    color: AppColors.codeTitle,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _diffLine(String line) {
    Color color;
    Color? bg;
    if (line.startsWith('@@')) {
      color = AppColors.textSecondaryLight;
      bg = null;
    } else if (line.startsWith('-')) {
      color = AppColors.danger;
      bg = AppColors.diffDelBg;
    } else if (line.startsWith('+')) {
      color = AppColors.codeGreen;
      bg = AppColors.diffAddBg;
    } else {
      color = AppColors.textSecondaryLight;
      bg = null;
    }

    final text = Text(
      line,
      style: AppFont.mono(
        size: 12,
        weight: FontWeight.w400,
        color: color,
        height: 1.7,
      ),
    );

    if (bg == null) {
      return Align(alignment: Alignment.centerLeft, child: text);
    }
    return Container(
      margin: const EdgeInsets.only(bottom: 1),
      padding: const EdgeInsets.symmetric(horizontal: 5),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(3),
      ),
      child: text,
    );
  }
}
