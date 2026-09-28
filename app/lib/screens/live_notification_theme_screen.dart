import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../services/live_update.dart';
import '../theme/tokens.dart';

enum LiveThemeStatus {
  running('运行中', '小梦正在专注处理', 'running', 'running', AppColors.lime),
  approval('待确认', '有件事，等你确认', 'needs_approval', 'approval', Color(0xFFF0C761)),
  completed('已完成', '这次任务，已顺利完成', 'done', 'completed', AppColors.lime),
  offline('已离线', '连接已断开，正在尝试重连', 'offline', 'offline', AppColors.nightMuted);

  const LiveThemeStatus(
    this.label,
    this.detail,
    this.status,
    this.asset,
    this.color,
  );
  final String label;
  final String detail;
  final String status;
  final String asset;
  final Color color;
  String get assetPath => 'assets/live-notifications/$asset.png';
}

class LiveNotificationThemeScreen extends StatefulWidget {
  const LiveNotificationThemeScreen({super.key});

  @override
  State<LiveNotificationThemeScreen> createState() =>
      _LiveNotificationThemeScreenState();
}

class _LiveNotificationThemeScreenState
    extends State<LiveNotificationThemeScreen> {
  LiveThemeStatus _status = LiveThemeStatus.running;
  bool _sending = false;

  Future<void> _preview() async {
    setState(() => _sending = true);
    final shown = await LiveUpdate.previewTheme(_status.status);
    if (!mounted) return;
    setState(() => _sending = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(shown ? '预览通知已发送，20 秒后自动收起' : '无法显示预览，请检查系统通知权限')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final android = !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
    return Scaffold(
      appBar: AppBar(title: const Text('实时通知外观')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text(
                '小梦，\n实时在场。',
                style: AppFont.ui(
                  size: 32,
                  weight: FontWeight.w600,
                  height: 1.25,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                '瓷白小梦与青柠星光，让任务进度一眼可见。',
                style: AppFont.ui(color: AppColors.textSecondary),
              ),
              const SizedBox(height: 24),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: LiveThemeStatus.values
                    .map(
                      (status) => ChoiceChip(
                        label: Text(status.label),
                        selected: status == _status,
                        onSelected: (_) => setState(() => _status = status),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 28),
              Text('顶部状态示意', style: AppFont.ui(weight: FontWeight.w600)),
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.night,
                    borderRadius: BorderRadius.circular(32),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Image.asset(
                        'assets/ui-v3/mascot-avatar.png',
                        width: 28,
                        height: 28,
                        excludeFromSemantics: true,
                      ),
                      const SizedBox(width: 14),
                      Icon(Icons.circle, size: 8, color: _status.color),
                      const SizedBox(width: 8),
                      Text(
                        _status.label,
                        style: AppFont.ui(
                          color: AppColors.onNight,
                          weight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 24),
              Text('展开卡片示意', style: AppFont.ui(weight: FontWeight.w600)),
              const SizedBox(height: 12),
              LiveThemePreviewCard(status: _status),
              const SizedBox(height: 16),
              Text(
                '示例任务与进度仅用于外观预览，不执行审批或真实任务。',
                style: AppFont.ui(
                  size: 12,
                  color: AppColors.textSecondary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: android && !_sending ? _preview : null,
                icon: const Icon(Icons.notifications_active_outlined),
                label: Text(_sending ? '正在发送…' : '发送系统预览通知'),
              ),
              const SizedBox(height: 12),
              Text(
                'Android 16 实时通知保留系统布局，使用小梦头像、状态图标和青柠进度条。较早版本的展开通知使用深墨主题卡片。审批与完成通知也已更新主题。\n\n顶部胶囊能否显示及实际样式由系统、通知权限和手机厂商决定；完成或离线后会回到普通通知。',
                style: AppFont.ui(
                  size: 13,
                  color: AppColors.textSecondary,
                  height: 1.65,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class LiveThemePreviewCard extends StatelessWidget {
  const LiveThemePreviewCard({super.key, required this.status});
  final LiveThemeStatus status;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: AppColors.night,
      borderRadius: BorderRadius.circular(16),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            ClipOval(
              child: Image.asset(
                status.assetPath,
                width: 64,
                height: 64,
                excludeFromSemantics: true,
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '示例任务 · 品牌官网',
                    style: AppFont.ui(
                      size: 16,
                      weight: FontWeight.w600,
                      color: AppColors.onNight,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    status.label,
                    style: AppFont.ui(size: 12, color: status.color),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        Text(
          status.detail,
          style: AppFont.ui(color: AppColors.onNight, height: 1.5),
        ),
        if (status == LiveThemeStatus.running) ...[
          const SizedBox(height: 16),
          Row(
            children: [
              const Expanded(
                child: LinearProgressIndicator(
                  value: 0.6,
                  minHeight: 5,
                  color: AppColors.lime,
                  backgroundColor: Color(0xFF394047),
                  borderRadius: BorderRadius.all(Radius.circular(4)),
                ),
              ),
              const SizedBox(width: 12),
              Text(
                '3 / 5',
                style: AppFont.ui(size: 12, color: AppColors.nightMuted),
              ),
            ],
          ),
        ],
      ],
    ),
  );
}
