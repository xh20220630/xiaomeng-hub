import 'package:flutter/material.dart';
import '../services/ws_service.dart';
import '../theme/tokens.dart';

/// 连接状态徽标（F1 顶栏右侧）：
/// 已连接 → 绿点 + 「已连接」bg greenLight；连接中 → 黄；离线 → 红。
/// 圆角 20，内边距 5x11，字 13/700，文案随 [WsStatus]。
class ConnBadge extends StatelessWidget {
  final WsStatus status;
  const ConnBadge(this.status, {super.key});

  @override
  Widget build(BuildContext context) {
    late final Color dot;
    late final String label;
    late final Color bg;
    switch (status) {
      case WsStatus.connected:
        dot = AppColors.success;
        label = '已连接';
        bg = AppColors.greenLight;
        break;
      case WsStatus.connecting:
        dot = const Color(0xFFCDA23B); // 暖黄
        label = '连接中';
        bg = const Color(0xFFF6EFDD);
        break;
      case WsStatus.disconnected:
        dot = AppColors.danger;
        label = '未连接';
        bg = AppColors.rejectCapsuleBg;
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 11),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(AppRadii.badge),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          Text(label, style: AppFont.ui(size: 13, weight: FontWeight.w700, color: dot)),
        ],
      ),
    );
  }
}
