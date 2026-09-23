import 'package:flutter/material.dart';

import '../models.dart';
import '../theme/tokens.dart';
import 'dream_motion.dart';
import 'studio_icon.dart';

class StudioSidebar extends StatelessWidget {
  const StudioSidebar({
    super.key,
    required this.projects,
    required this.selectedView,
    required this.selectedProject,
    required this.online,
    required this.connected,
    required this.pending,
    required this.onNavigate,
    required this.onProject,
    required this.onNewChat,
    required this.onAgents,
    required this.onSettings,
  });

  final List<Project> projects;
  final String? selectedView;
  final String? selectedProject;
  final int online;
  final int pending;
  final bool connected;
  final ValueChanged<String> onNavigate;
  final ValueChanged<Project> onProject;
  final VoidCallback onNewChat;
  final VoidCallback onAgents;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) => Material(
    color: AppColors.night,
    child: LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight),
          child: IntrinsicHeight(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Image.asset(
                        'assets/ui-v3/mascot-avatar.png',
                        width: 32,
                        height: 36,
                        excludeFromSemantics: true,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '小梦',
                              style: AppFont.ui(
                                size: 23,
                                weight: FontWeight.w600,
                                color: AppColors.onNight,
                              ),
                            ),
                            Text(
                              '夜航工作室',
                              style: AppFont.ui(
                                size: 10,
                                color: AppColors.nightMuted,
                                letterSpacing: 1,
                              ),
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        onPressed: onNewChat,
                        tooltip: '新会话',
                        icon: const Icon(
                          Icons.add,
                          color: AppColors.onNight,
                          size: 21,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Image.asset(
                      'assets/ui-v3/hero-orbit.png',
                      width: 154,
                      height: 138,
                      fit: BoxFit.contain,
                      excludeFromSemantics: true,
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 8, 0, 18),
                    child: Text(
                      '灵感，随时在场。',
                      style: AppFont.ui(
                        size: 17,
                        weight: FontWeight.w500,
                        color: AppColors.onNight,
                      ),
                    ),
                  ),
                  _nav(StudioSymbol.conversations, '会话', '会话'),
                  _nav(StudioSymbol.projects, '项目', '项目'),
                  _nav(StudioSymbol.inbox, '收件箱', '待处理'),
                  _nav(StudioSymbol.archive, '归档', '已归档'),
                  const Divider(height: 28, color: Color(0xFF30373A)),
                  Padding(
                    padding: const EdgeInsets.only(left: 8, bottom: 8),
                    child: Text(
                      '工作空间',
                      style: AppFont.ui(size: 11, color: AppColors.nightMuted),
                    ),
                  ),
                  for (final project in projects.take(4))
                    ListTile(
                      minTileHeight: 48,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                      minLeadingWidth: 24,
                      leading: const StudioIcon(
                        StudioSymbol.projects,
                        size: 27,
                      ),
                      selected: selectedProject == project.projectId,
                      selectedTileColor: AppColors.nightRaised,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                      title: Text(
                        project.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppFont.ui(size: 12, color: AppColors.onNight),
                      ),
                      trailing: const Icon(
                        Icons.chevron_right,
                        size: 17,
                        color: AppColors.nightMuted,
                      ),
                      onTap: () => onProject(project),
                    ),
                  if (projects.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: Text(
                        '连接主机后显示项目',
                        style: AppFont.ui(
                          size: 11,
                          color: AppColors.nightMuted,
                        ),
                      ),
                    ),
                  if (projects.length > 4)
                    TextButton(
                      style: TextButton.styleFrom(
                        foregroundColor: AppColors.nightMuted,
                        alignment: Alignment.centerLeft,
                      ),
                      onPressed: () => onNavigate('项目'),
                      child: const Text('查看全部项目'),
                    ),
                  const Spacer(),
                  const SizedBox(height: 20),
                  Material(
                    color: AppColors.nightRaised,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(AppRadii.card),
                      side: const BorderSide(color: Color(0xFF30373A)),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: InkWell(
                      onTap: onAgents,
                      child: Padding(
                        padding: const EdgeInsets.all(14),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                DreamActivityDot(
                                  active: connected && online > 0,
                                  color: connected && online > 0
                                      ? AppColors.lime
                                      : AppColors.nightMuted,
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    connected ? '$online 个 Agent 在线' : '主机未连接',
                                    style: AppFont.ui(
                                      size: 12,
                                      weight: FontWeight.w500,
                                      color: AppColors.onNight,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const Divider(height: 22, color: Color(0xFF30373A)),
                            Row(
                              children: [
                                const StudioIcon(StudioSymbol.agents, size: 27),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    '远程主机与 Agent',
                                    style: AppFont.ui(
                                      size: 11,
                                      color: AppColors.onNight,
                                    ),
                                  ),
                                ),
                                const Icon(
                                  Icons.chevron_right,
                                  size: 17,
                                  color: AppColors.nightMuted,
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 6),
                    minLeadingWidth: 24,
                    leading: const StudioIcon(StudioSymbol.settings, size: 27),
                    title: Text(
                      '连接设置',
                      style: AppFont.ui(size: 12, color: AppColors.onNight),
                    ),
                    trailing: const Icon(
                      Icons.chevron_right,
                      size: 17,
                      color: AppColors.nightMuted,
                    ),
                    onTap: onSettings,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );

  Widget _nav(StudioSymbol symbol, String label, String view) {
    final selected = selectedView == view && selectedProject == null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: ListTile(
        minTileHeight: 48,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12),
        minLeadingWidth: 26,
        selected: selected,
        selectedTileColor: AppColors.lime,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        leading: StudioIcon(symbol, size: 30),
        title: Text(
          label,
          style: AppFont.ui(
            size: 14,
            weight: selected ? FontWeight.w600 : FontWeight.w400,
            color: selected ? AppColors.ink : AppColors.onNight,
          ),
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (symbol == StudioSymbol.inbox && pending > 0) ...[
              Text(
                '$pending',
                style: AppFont.ui(
                  size: 12,
                  color: selected ? AppColors.ink : AppColors.lime,
                ),
              ),
              const SizedBox(width: 8),
            ],
            Icon(
              Icons.chevron_right,
              size: 18,
              color: selected ? AppColors.ink : AppColors.nightMuted,
            ),
          ],
        ),
        onTap: () => onNavigate(view),
      ),
    );
  }
}
