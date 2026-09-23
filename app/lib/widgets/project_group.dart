import 'package:flutter/material.dart';
import '../models.dart';
import '../theme/tokens.dart';
import '../util.dart';
import 'mascot.dart';

/// A project section on the home page (sidebar-style, mirroring Claude Code's
/// own project → sessions tree): a project header plus the list of its real
/// sessions (newest-first). Tapping a session row opens that specific
/// conversation; tapping the header opens the active (latest) session.
class ProjectGroup extends StatefulWidget {
  final Project project;
  final bool highlight; // needs-approval emphasis (ochre)
  final void Function(Project project, String? sessionId) onOpen;
  const ProjectGroup({
    super.key,
    required this.project,
    required this.onOpen,
    this.highlight = false,
  });

  @override
  State<ProjectGroup> createState() => _ProjectGroupState();
}

class _ProjectGroupState extends State<ProjectGroup> {
  static const _collapsedMax = 5;
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final p = widget.project;
    final sessions = p.sessions;
    final hasMore = sessions.length > _collapsedMax;
    final visible = (_expanded || !hasMore)
        ? sessions
        : sessions.take(_collapsedMax).toList();

    return Container(
      margin: const EdgeInsets.only(bottom: 13),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: AppColors.card,
        border: Border.all(
          color: widget.highlight ? AppColors.primary : AppColors.borderWarm,
          width: widget.highlight ? 2 : 1.5,
        ),
        borderRadius: BorderRadius.circular(AppRadii.card),
        boxShadow: widget.highlight
            ? [
                BoxShadow(
                  color: AppColors.primary.withValues(alpha: 0.16),
                  blurRadius: 14,
                  offset: const Offset(0, 4),
                ),
              ]
            : const [
                BoxShadow(
                  color: Color(0x0A000000),
                  blurRadius: 8,
                  offset: Offset(0, 2),
                ),
              ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _header(p),
          for (final s in visible)
            _SessionRow(
              session: s,
              isActive: s.sessionId == p.activeSessionId,
              onTap: () => widget.onOpen(p, s.sessionId),
            ),
          if (hasMore) _expandToggle(sessions.length - _collapsedMax),
        ],
      ),
    );
  }

  Widget _header(Project p) {
    final approval = p.pendingApproval;
    final count = p.sessionCount > 0 ? p.sessionCount : p.sessions.length;
    final sub = widget.highlight
        ? ((approval?.command != null && approval!.command!.isNotEmpty)
              ? '请求执行 ${approval.command}'
              : '需要你的处理')
        : '$count 个会话';
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => widget.onOpen(p, p.activeSessionId),
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 13, 12),
        color: widget.highlight ? AppColors.warnBarBg : AppColors.card,
        child: Row(
          children: [
            MascotImage.forStatus(p.status, size: 30, floaty: widget.highlight),
            const SizedBox(width: 11),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    p.sourceLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppFont.ui(size: 11, color: AppColors.textSecondary),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    p.name,
                    style: AppFont.mono(
                      size: 14,
                      weight: FontWeight.w700,
                      color: AppColors.ink,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    sub,
                    style: AppFont.ui(
                      size: 12,
                      weight: FontWeight.w600,
                      color: widget.highlight
                          ? AppColors.primaryDeep
                          : AppColors.textSecondary,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            _StatusDot(status: p.status),
            const SizedBox(width: 7),
            Text(
              '›',
              style: AppFont.ui(
                size: 20,
                weight: FontWeight.w700,
                color: widget.highlight
                    ? AppColors.primary
                    : AppColors.textPlaceholder,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _expandToggle(int hidden) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => setState(() => _expanded = !_expanded),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: const BoxDecoration(
          border: Border(
            top: BorderSide(color: AppColors.borderLight, width: 1),
          ),
        ),
        alignment: Alignment.center,
        child: Text(
          _expanded ? '收起 ▴' : '展开其余 $hidden 个会话 ▾',
          style: AppFont.ui(
            size: 12,
            weight: FontWeight.w700,
            color: AppColors.primaryDeep,
          ),
        ),
      ),
    );
  }
}

/// One session row under a project: status dot + real ai-title + relative time.
class _SessionRow extends StatelessWidget {
  final Session session;
  final bool isActive;
  final VoidCallback onTap;
  const _SessionRow({
    required this.session,
    required this.isActive,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final title = (session.summary != null && session.summary!.isNotEmpty)
        ? session.summary!
        : '未命名会话';
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 11, 14, 11),
        decoration: const BoxDecoration(
          border: Border(
            top: BorderSide(color: AppColors.borderLight, width: 1),
          ),
        ),
        child: Row(
          children: [
            _StatusDot(status: session.status, small: true),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                title,
                style: AppFont.ui(
                  size: 13,
                  weight: isActive ? FontWeight.w700 : FontWeight.w600,
                  color: isActive ? AppColors.ink : AppColors.doneNameGray,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              timeAgo(session.updatedAt),
              style: AppFont.ui(
                size: 11,
                weight: FontWeight.w600,
                color: AppColors.textPlaceholder,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A small colored status dot (project header + session rows).
class _StatusDot extends StatelessWidget {
  final String status;
  final bool small;
  const _StatusDot({required this.status, this.small = false});

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      'needs_approval' => AppColors.primaryDeep,
      'running' || 'waiting_input' => AppColors.primary,
      'error' => AppColors.danger,
      _ => AppColors.textPlaceholder2,
    };
    final d = small ? 7.0 : 8.0;
    return Container(
      width: d,
      height: d,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}
