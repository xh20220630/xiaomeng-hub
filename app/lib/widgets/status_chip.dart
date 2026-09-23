import 'package:flutter/material.dart';
import '../theme/tokens.dart';

class StatusStyle {
  final Color color;
  final IconData icon;
  final String label;
  const StatusStyle(this.color, this.icon, this.label);
}

StatusStyle statusStyle(String status) {
  switch (status) {
    case 'running':
      return const StatusStyle(AppColors.success, Icons.autorenew, '运行中');
    case 'needs_approval':
      return const StatusStyle(Color(0xFF976019), Icons.gpp_maybe, '需审批');
    case 'waiting_input':
      return const StatusStyle(Color(0xFF976019), Icons.hourglass_top, '等待输入');
    case 'done':
      return const StatusStyle(
        AppColors.success,
        Icons.check_circle_outline,
        '已完成',
      );
    case 'error':
      return const StatusStyle(AppColors.danger, Icons.error_outline, '异常');
    case 'rejected':
      return const StatusStyle(AppColors.danger, Icons.block_outlined, '已拒绝');
    case 'offline':
      return const StatusStyle(
        AppColors.textSecondary,
        Icons.cloud_off_outlined,
        '离线',
      );
    case 'ended':
      return const StatusStyle(Color(0xFF6B7280), Icons.stop_circle, '已结束');
    case 'notification':
      return const StatusStyle(Color(0xFF06B6D4), Icons.notifications, '通知');
    default:
      return StatusStyle(const Color(0xFF6B7280), Icons.circle, status);
  }
}

class StatusChip extends StatelessWidget {
  final String status;
  const StatusChip(this.status, {super.key});

  @override
  Widget build(BuildContext context) {
    final s = statusStyle(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: s.color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppRadii.badge),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(s.icon, size: 13, color: s.color),
          const SizedBox(width: 4),
          Text(
            s.label,
            style: TextStyle(
              color: s.color,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
