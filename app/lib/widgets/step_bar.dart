import 'package:flutter/material.dart';
import '../theme/tokens.dart';

/// Visual state of a single step node in the four-stage step bar.
enum _NodeState { done, active, activeHollow, pending, rejected }

/// The four-stage step bar shown at the top of the project detail screen:
/// 规划 → 执行 → 审批 → 完成. State is derived from the project [status]
/// exactly per BUILD_SPEC §5 F2.
class StepBar extends StatelessWidget {
  final String status;
  const StepBar(this.status, {super.key});

  @override
  Widget build(BuildContext context) {
    final states = _statesFor(status);
    // Connector colour between node i and node i+1.
    final lines = _linesFor(states);

    return Container(
      width: double.infinity,
      decoration: const BoxDecoration(
        color: AppColors.warmWhite,
        border: Border(
          bottom: BorderSide(color: AppColors.borderDivider, width: 1.5),
        ),
      ),
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 13),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _node('规划', states[0]),
          _line(lines[0]),
          _node('执行', states[1]),
          _line(lines[1]),
          _node('审批', states[2]),
          _line(lines[2]),
          _node('完成', states[3]),
        ],
      ),
    );
  }

  /// State of [规划, 执行, 审批, 完成] for the given status.
  List<_NodeState> _statesFor(String s) {
    switch (s) {
      case 'needs_approval':
        // 执行 done / 审批 activeHollow / 完成 pending
        return const [
          _NodeState.done,
          _NodeState.done,
          _NodeState.activeHollow,
          _NodeState.pending,
        ];
      case 'done':
      case 'ended':
        // all done (完成 active)
        return const [
          _NodeState.done,
          _NodeState.done,
          _NodeState.done,
          _NodeState.active,
        ];
      case 'rejected':
      case 'paused':
        // 执行 done / 审批 rejected / 完成 pending
        return const [
          _NodeState.done,
          _NodeState.done,
          _NodeState.rejected,
          _NodeState.pending,
        ];
      case 'running':
      case 'waiting_input':
      default:
        // 规划 done / 执行 active / 审批 pending / 完成 pending
        return const [
          _NodeState.done,
          _NodeState.active,
          _NodeState.pending,
          _NodeState.pending,
        ];
    }
  }

  /// Connector colours, one per gap (3 gaps for 4 nodes).
  /// done-reaching lines are green; the entry line into a rejected node uses
  /// rejectLine; everything else is the grey pending line.
  List<Color> _linesFor(List<_NodeState> n) {
    Color lineInto(_NodeState target, _NodeState source) {
      if (target == _NodeState.done) return AppColors.success;
      if (target == _NodeState.rejected) return AppColors.rejectLine;
      // Reached an active node coming from a completed stage -> still pending.
      return AppColors.stepPendingLine;
    }

    return [
      lineInto(n[1], n[0]),
      lineInto(n[2], n[1]),
      lineInto(n[3], n[2]),
    ];
  }

  Widget _line(Color color) => Expanded(
        child: Container(
          height: 2.5,
          margin: const EdgeInsets.only(left: 4, right: 4, bottom: 16),
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      );

  Widget _node(String label, _NodeState state) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _dot(state),
        const SizedBox(height: 5),
        Text(
          label,
          style: AppFont.ui(
            size: 10,
            weight: FontWeight.w700,
            color: _labelColor(state),
          ),
        ),
      ],
    );
  }

  Color _labelColor(_NodeState state) {
    switch (state) {
      case _NodeState.done:
        return AppColors.success;
      case _NodeState.active:
      case _NodeState.activeHollow:
        return AppColors.primaryDeep;
      case _NodeState.rejected:
        return AppColors.rejectCapsuleText;
      case _NodeState.pending:
        return AppColors.textPlaceholder;
    }
  }

  Widget _dot(_NodeState state) {
    switch (state) {
      case _NodeState.done:
        // 绿 16 实心 + 白 ✓
        return _circle(
          size: 16,
          color: AppColors.success,
          child: const Icon(Icons.check, size: 9, color: Colors.white),
        );
      case _NodeState.active:
        // 赭 18 实心 + halo 光环
        return _circle(
          size: 18,
          color: AppColors.primary,
          ring: AppColors.halo,
        );
      case _NodeState.activeHollow:
        // 白 18 + 赭 2px 边 + halo 光环
        return _circle(
          size: 18,
          color: AppColors.card,
          border: Border.all(color: AppColors.primary, width: 2),
          ring: AppColors.halo,
        );
      case _NodeState.rejected:
        // C98A76 18 + 白 ✕
        return _circle(
          size: 18,
          color: AppColors.primaryRejected,
          child: const Icon(Icons.close, size: 10, color: Colors.white),
        );
      case _NodeState.pending:
        // 白 16 + dashed C9C0B0 边
        return CustomPaint(
          painter: _DashedCirclePainter(AppColors.stepDashedBorder),
          child: const SizedBox(width: 16, height: 16),
        );
    }
  }

  Widget _circle({
    required double size,
    required Color color,
    Widget? child,
    BoxBorder? border,
    Color? ring,
  }) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        border: border,
        boxShadow: ring == null
            ? null
            : [BoxShadow(color: ring, spreadRadius: 3, blurRadius: 0)],
      ),
      child: child,
    );
  }
}

/// Paints a dashed-border ring for the pending node, matching
/// `2px dashed #c9c0b0` from the prototype.
class _DashedCirclePainter extends CustomPainter {
  final Color color;
  const _DashedCirclePainter(this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final radius = (size.width / 2) - 1;
    final center = Offset(size.width / 2, size.height / 2);
    const dashCount = 12;
    const sweep = 6.2831853 / dashCount;
    const gapFraction = 0.45;
    for (var i = 0; i < dashCount; i++) {
      final start = i * sweep;
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        start,
        sweep * (1 - gapFraction),
        false,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_DashedCirclePainter oldDelegate) =>
      oldDelegate.color != color;
}
