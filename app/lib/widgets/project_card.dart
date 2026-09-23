import 'package:flutter/material.dart';
import '../models.dart';
import '../theme/tokens.dart';
import 'mascot.dart';

/// 待处理卡片（「需要你处理」组）：bg card，赭石 2px 描边，radius18，
/// padding14，待处理阴影 0 4 14 rgba(217,119,87,.16)。
/// 左 MascotImage(approval,46,floaty) + 列(项目名 mono14/700 ink；副 13/600 primaryDeep) + 右 › 22/700 primary。
class PendingCard extends StatelessWidget {
  final Project project;
  final VoidCallback onTap;
  const PendingCard({super.key, required this.project, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final cmd = project.pendingApproval?.command;
    final sub = (cmd != null && cmd.isNotEmpty) ? '请求执行 $cmd' : '请求你的处理';
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.card,
          border: Border.all(color: AppColors.primary, width: 2),
          borderRadius: BorderRadius.circular(AppRadii.card),
          boxShadow: [
            BoxShadow(
              color: AppColors.primary.withValues(alpha: 0.16),
              blurRadius: 14,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Row(
          children: [
            const MascotImage(MascotMood.approval, size: 46, floaty: true),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    project.name,
                    style: AppFont.mono(size: 14, weight: FontWeight.w700, color: AppColors.ink),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    sub,
                    style: AppFont.ui(size: 13, weight: FontWeight.w600, color: AppColors.primaryDeep),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text('›', style: AppFont.ui(size: 22, weight: FontWeight.w700, color: AppColors.primary)),
          ],
        ),
      ),
    );
  }
}

/// 进行中卡片（「进行中」组）：bg card，border 1.5 borderWarm，radius18，
/// padding 13x14，普通阴影 0 2 8 rgba(0,0,0,.04)。
/// 左 MascotImage(running,40) + 列(名 mono14/700；副 13/600 textSecondary) + 右脉冲点 8 圆 primary。
class RunningCard extends StatefulWidget {
  final Project project;
  final VoidCallback onTap;
  const RunningCard({super.key, required this.project, required this.onTap});

  @override
  State<RunningCard> createState() => _RunningCardState();
}

class _RunningCardState extends State<RunningCard> with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    // pulse 1.4s：opacity 1 → .25 → 1
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));
    if (!kStaticCapture) _ctrl.repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.project;
    final sub = (p.summary != null && p.summary!.isNotEmpty) ? p.summary! : '运行中…';
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 13, horizontal: 14),
        decoration: BoxDecoration(
          color: AppColors.card,
          border: Border.all(color: AppColors.borderWarm, width: 1.5),
          borderRadius: BorderRadius.circular(AppRadii.card),
          boxShadow: const [
            BoxShadow(
              color: Color(0x0A000000), // rgba(0,0,0,.04)
              blurRadius: 8,
              offset: Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          children: [
            const MascotImage(MascotMood.running, size: 40),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    p.name,
                    style: AppFont.mono(size: 14, weight: FontWeight.w700, color: AppColors.ink),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    sub,
                    style: AppFont.ui(size: 13, weight: FontWeight.w600, color: AppColors.textSecondary),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            FadeTransition(
              opacity: _ctrl.drive(Tween(begin: 1.0, end: 0.25)),
              child: Container(
                width: 8,
                height: 8,
                decoration: const BoxDecoration(color: AppColors.primary, shape: BoxShape.circle),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 今日完成列表（「今日完成」组）：单容器白卡 radius18 overflow hidden，
/// border 1.5 borderWarm；每行 padding 13x15 space-between，行间 border-bottom 1px borderLight（末行无）。
/// 左项目名 mono13/700、右状态 12/700 success。首行 bg doneRowBg、名 ink；其余名 doneNameGray。
class DoneList extends StatelessWidget {
  final List<Project> projects;
  final void Function(Project project) onTapProject;
  const DoneList({super.key, required this.projects, required this.onTapProject});

  @override
  Widget build(BuildContext context) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: AppColors.card,
        border: Border.all(color: AppColors.borderWarm, width: 1.5),
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < projects.length; i++)
            _DoneRow(
              project: projects[i],
              first: i == 0,
              last: i == projects.length - 1,
              onTap: () => onTapProject(projects[i]),
            ),
        ],
      ),
    );
  }
}

class _DoneRow extends StatelessWidget {
  final Project project;
  final bool first;
  final bool last;
  final VoidCallback onTap;
  const _DoneRow({required this.project, required this.first, required this.last, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 13, horizontal: 15),
        decoration: BoxDecoration(
          color: first ? AppColors.doneRowBg : AppColors.card,
          border: last
              ? null
              : const Border(bottom: BorderSide(color: AppColors.borderLight, width: 1)),
        ),
        child: Row(
          children: [
            Text(
              project.name,
              style: AppFont.mono(
                size: 13,
                weight: FontWeight.w700,
                color: first ? AppColors.ink : AppColors.doneNameGray,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(width: 10),
            // Real session title (ai-title) as a dim subtitle; ellipsized so it
            // never overflows. Full title is on the detail screen.
            Expanded(
              child: Text(
                project.summary ?? '',
                style: AppFont.ui(size: 12, weight: FontWeight.w600, color: AppColors.textPlaceholder),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.right,
              ),
            ),
            const SizedBox(width: 8),
            const Icon(Icons.check_circle, size: 15, color: AppColors.success),
          ],
        ),
      ),
    );
  }
}
