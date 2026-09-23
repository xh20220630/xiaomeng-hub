import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/monitor.dart';
import '../services/ws_service.dart';
import '../theme/tokens.dart';
import '../widgets/studio_widgets.dart';
import '../widgets/dream_motion.dart';
import '../widgets/studio_icon.dart';
import 'settings_screen.dart';
import 'pair_host_screen.dart';

const capabilityLabels = {
  'message.send': '发送消息',
  'message.steer': '追加指令',
  'session.start': '新建会话',
  'session.stop': '停止任务',
  'approval.respond': '远程审批',
  'history.read': '完整历史',
  'agent.catalog': '主机能力',
  'session.configure': '模型与设置',
  'session.compact': '压缩上下文',
  'agent.action': '扩展操作',
};

class AgentsScreen extends ConsumerWidget {
  const AgentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(monitorProvider.select((s) => s.agents));
    ref.watch(monitorProvider.select((s) => s.serverProjects));
    ref.watch(monitorProvider.select((s) => s.status));
    final monitor = ref.read(monitorProvider);
    final agents = monitor.agents.values.toList()
      ..sort((a, b) => a.nodeName.compareTo(b.nodeName));
    final hosts = {for (final agent in agents) agent.nodeId};
    final connected = monitor.status == WsStatus.connected;
    return Scaffold(
      appBar: AppBar(
        title: const Text('远程主机与 Agent'),
        actions: [
          IconButton(
            tooltip: '扫码绑定宿主机',
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => const PairHostScreen()),
            ),
            icon: const Icon(Icons.qr_code_scanner_rounded),
          ),
          IconButton(
            tooltip: '连接设置',
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => const SettingsScreen()),
            ),
            icon: const StudioIcon(StudioSymbol.settings, size: 25),
          ),
          const SizedBox(width: 12),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 800),
          child: RefreshIndicator(
            onRefresh: () async =>
                ref.read(monitorProvider.notifier).reconnect(),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(24),
              children: [
                Text(
                  '你的创造力，\n不受距离限制。',
                  style: AppFont.ui(
                    size: 29,
                    height: 1.35,
                    weight: FontWeight.w600,
                    letterSpacing: -.8,
                  ),
                ),
                const SizedBox(height: 24),
                DreamPageIntro(
                  eyebrow: connected ? '连接正常' : '等待连接',
                  title: '${hosts.length} 台主机',
                  subtitle: connected
                      ? '${agents.where((a) => a.online).length} 个 Agent 在线 · 创意与算力相连'
                      : '中心服务未连接 · 显示上次同步的信息',
                  icon: Icons.hub_outlined,
                  dark: true,
                  art: 'assets/ui-v3/agents-art.png',
                ),
                const SizedBox(height: 26),
                Row(
                  children: [
                    Text(
                      '我的设备',
                      style: AppFont.ui(size: 20, weight: FontWeight.w600),
                    ),
                    const Spacer(),
                    TextButton.icon(
                      onPressed: () =>
                          ref.read(monitorProvider.notifier).reconnect(),
                      icon: const Icon(Icons.refresh_rounded, size: 18),
                      label: const Text('刷新'),
                    ),
                  ],
                ),
                for (final host in hosts) ...[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(0, 22, 0, 12),
                    child: Row(
                      children: [
                        const StudioIcon(StudioSymbol.agents, size: 27),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            agents.firstWhere((a) => a.nodeId == host).nodeName,
                            style: AppFont.ui(
                              size: 16,
                              weight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  for (final agent in agents.where((a) => a.nodeId == host))
                    DreamPress(
                      child: Card(
                        margin: const EdgeInsets.only(bottom: 12),
                        clipBehavior: Clip.antiAlias,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(AppRadii.card),
                          side: const BorderSide(color: AppColors.borderWarm),
                        ),
                        child: InkWell(
                          onTap: () => Navigator.pop(context, agent.agentId),
                          child: Padding(
                            padding: const EdgeInsets.all(20),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    const StudioIcon(
                                      StudioSymbol.agents,
                                      size: 38,
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            agent.name,
                                            style: AppFont.ui(
                                              size: 17,
                                              weight: FontWeight.w600,
                                            ),
                                          ),
                                          const SizedBox(height: 5),
                                          Text(
                                            '${agent.provider} · ${monitor.projects.where((p) => p.agentId == agent.agentId).fold<int>(0, (sum, p) => sum + p.sessionCount)} 个任务',
                                            style: AppFont.ui(
                                              size: 11,
                                              color: AppColors.textSecondary,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    const Icon(
                                      Icons.chevron_right_rounded,
                                      color: AppColors.textSecondary,
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 16),
                                Row(
                                  children: [
                                    DreamActivityDot(
                                      color: connected && agent.online
                                          ? AppColors.success
                                          : AppColors.textPlaceholder,
                                      active: connected && agent.online,
                                    ),
                                    const SizedBox(width: 7),
                                    Text(
                                      !connected
                                          ? '连接未知'
                                          : agent.online
                                          ? '在线'
                                          : '离线',
                                      style: AppFont.ui(
                                        size: 11,
                                        color: AppColors.textSecondary,
                                      ),
                                    ),
                                  ],
                                ),
                                const Divider(height: 28),
                                Wrap(
                                  spacing: 6,
                                  runSpacing: 6,
                                  children: [
                                    const Chip(
                                      label: Text('任务监控'),
                                      visualDensity: VisualDensity.compact,
                                    ),
                                    for (final capability in agent.capabilities)
                                      Chip(
                                        label: Text(
                                          capabilityLabels[capability] ??
                                              capability,
                                        ),
                                        visualDensity: VisualDensity.compact,
                                      ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
                if (agents.isEmpty) ...[
                  const SizedBox(height: 20),
                  Center(
                    child: Image.asset(
                      'assets/ui-v3/empty-state.png',
                      width: 130,
                      height: 130,
                      excludeFromSemantics: true,
                    ),
                  ),
                  Center(
                    child: Text(
                      '暂无 Agent 接入',
                      style: AppFont.ui(
                        size: 14,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 22),
                OutlinedButton.icon(
                  onPressed: () => Navigator.pop(context, ''),
                  icon: const Icon(Icons.arrow_outward_rounded, size: 18),
                  label: const Text('查看全部任务'),
                ),
                const SizedBox(height: 24),
                Text(
                  '连接其他机器',
                  style: AppFont.ui(size: 15, weight: FontWeight.w600),
                ),
                const SizedBox(height: 10),
                Text(
                  '在电脑上启动 Claude Code、Codex 或自定义 Agent 的小梦接入端，连接同一个中心服务。选择主机下的 Agent，即可查看任务并远程操作。',
                  style: AppFont.ui(
                    size: 12,
                    color: AppColors.textSecondary,
                    height: 1.8,
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
