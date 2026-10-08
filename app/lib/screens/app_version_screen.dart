import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:gpt_markdown/gpt_markdown.dart';

import '../services/app_updates.dart';
import '../state/app_updates.dart';
import '../state/release_history.dart';
import '../theme/tokens.dart';
import '../widgets/markdown_link.dart';
import '../widgets/markdown_text.dart';

enum _HistoryFilter { all, stable, preview }

class AppVersionScreen extends ConsumerStatefulWidget {
  const AppVersionScreen({super.key});
  @override
  ConsumerState<AppVersionScreen> createState() => _AppVersionScreenState();
}

class _AppVersionScreenState extends ConsumerState<AppVersionScreen> {
  bool _showHistory = false;
  _HistoryFilter _filter = _HistoryFilter.all;
  String? _expandedId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(appUpdatesProvider).initialize();
      final history = ref.read(releaseHistoryProvider);
      if (!history.loaded) history.load();
    });
  }

  Future<void> _refresh() async {
    await Future.wait([
      ref.read(appUpdatesProvider).check(),
      ref.read(releaseHistoryProvider).load(refresh: true),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final updates = ref.watch(appUpdatesProvider);
    final history = ref.watch(releaseHistoryProvider);
    return ListenableBuilder(
      listenable: Listenable.merge([updates, history]),
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: const Text('版本管理'),
          centerTitle: true,
          actions: [
            IconButton(
              tooltip: '更新偏好',
              onPressed: () => showModalBottomSheet<void>(
                context: context,
                isScrollControlled: true,
                builder: (_) => _UpdatePreferences(updates: updates),
              ),
              icon: const Icon(Icons.tune_rounded),
            ),
            const SizedBox(width: 8),
          ],
        ),
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: RefreshIndicator(
              onRefresh: _refresh,
              child: ListView(
                key: const PageStorageKey('version-center'),
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 32),
                children: [
                  Text(
                    '让小梦，持续进步。',
                    textAlign: TextAlign.center,
                    style: AppFont.ui(color: AppColors.textSecondary),
                  ),
                  const SizedBox(height: 20),
                  _VersionHero(updates: updates, compact: _showHistory),
                  const SizedBox(height: 12),
                  _InstalledVersion(updates: updates, onCheck: _refresh),
                  if (updates.message != null) ...[
                    const SizedBox(height: 12),
                    Semantics(
                      liveRegion: true,
                      child: Text(
                        updates.message!,
                        style: AppFont.ui(
                          size: 12,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 20),
                  Container(
                    padding: const EdgeInsets.all(4),
                    decoration: BoxDecoration(
                      color: AppColors.drawer.withValues(alpha: .7),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Row(
                      children: [
                        for (final tab in [false, true])
                          Expanded(
                            child: TextButton(
                              style: TextButton.styleFrom(
                                minimumSize: const Size(0, 46),
                                backgroundColor: _showHistory == tab
                                    ? AppColors.halo
                                    : Colors.transparent,
                                foregroundColor: AppColors.ink,
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(10),
                                ),
                              ),
                              onPressed: () =>
                                  setState(() => _showHistory = tab),
                              child: Semantics(
                                selected: _showHistory == tab,
                                child: Text(
                                  tab ? '版本历史' : '更新说明',
                                  style: AppFont.ui(
                                    weight: _showHistory == tab
                                        ? FontWeight.w600
                                        : FontWeight.w400,
                                  ),
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),
                  if (_showHistory)
                    ..._historyContent(updates, history)
                  else
                    ..._overview(updates, history),
                  const _ReleaseLink(
                    url: 'https://github.com/$updateRepository/releases',
                    label: '打开官方下载页',
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _overview(AppUpdates updates, ReleaseHistory history) {
    final version = updates.available?.version ?? updates.installed;
    final record = history.entries
        .where((entry) => entry.matchesInstalled(version))
        .firstOrNull;
    final notes = updates.available?.notes ?? record?.notes;
    return [
      if (history.error != null) _HistoryError(history: history),
      if (history.fromCache) const _Hint('正在显示上次保存的更新说明'),
      if (history.notice != null) _Hint(history.notice!),
      if (notes != null)
        _Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (record != null) ...[
                Text(
                  '${record.dateLabel} · ${record.channelLabel}',
                  style: AppFont.ui(size: 12, color: AppColors.textSecondary),
                ),
                const SizedBox(height: 12),
              ],
              Text(
                updates.available != null ? '这次更新，带来了什么' : '当前版本更新说明',
                style: AppFont.ui(size: 20, weight: FontWeight.w600),
              ),
              const SizedBox(height: 16),
              _ReleaseNotes(notes),
              if (record?.url != null) _ReleaseLink(url: record!.url!),
            ],
          ),
        )
      else if (history.loading)
        const _LoadingHistory()
      else
        _Panel(
          child: Column(
            children: [
              const Icon(
                Icons.article_outlined,
                size: 32,
                color: AppColors.textSecondary,
              ),
              const SizedBox(height: 12),
              Text('暂未找到当前版本的更新说明', style: AppFont.ui(weight: FontWeight.w600)),
              const SizedBox(height: 8),
              const Text('可以在版本历史中浏览已发布的更新。', textAlign: TextAlign.center),
              TextButton(
                onPressed: () => setState(() => _showHistory = true),
                child: const Text('查看版本历史'),
              ),
            ],
          ),
        ),
      const SizedBox(height: 16),
      const _Hint('更新来自小梦官方 GitHub 仓库'),
    ];
  }

  List<Widget> _historyContent(AppUpdates updates, ReleaseHistory history) {
    final entries = history.entries
        .where(
          (entry) => switch (_filter) {
            _HistoryFilter.all => true,
            _HistoryFilter.stable => entry.preview == false,
            _HistoryFilter.preview => entry.preview == true,
          },
        )
        .toList();
    return [
      Text('每次进步，都有记录', style: AppFont.ui(size: 23, weight: FontWeight.w600)),
      const SizedBox(height: 6),
      Text('已发布的版本与更新说明', style: AppFont.ui(color: AppColors.textSecondary)),
      const SizedBox(height: 14),
      Wrap(
        spacing: 8,
        runSpacing: 6,
        children: [
          for (final filter in _HistoryFilter.values)
            ChoiceChip(
              label: Text(switch (filter) {
                _HistoryFilter.all => '全部',
                _HistoryFilter.stable => '正式版',
                _HistoryFilter.preview => '测试版',
              }),
              selected: _filter == filter,
              selectedColor: AppColors.lime,
              showCheckmark: false,
              onSelected: (_) => setState(() => _filter = filter),
            ),
        ],
      ),
      const SizedBox(height: 18),
      if (history.fromCache) const _Hint('已保存的历史记录 · 联网后可刷新'),
      if (history.notice != null) _Hint(history.notice!),
      if (history.error != null) _HistoryError(history: history),
      for (var i = 0; i < entries.length; i++)
        _HistoryCard(
          entry: entries[i],
          current: entries[i].matchesInstalled(updates.installed),
          latest: entries[i].id == history.entries.firstOrNull?.id,
          last: i == entries.length - 1,
          expanded: _expandedId == entries[i].id,
          onToggle: () => setState(() {
            _expandedId = _expandedId == entries[i].id ? null : entries[i].id;
          }),
        ),
      if (history.loading)
        const _LoadingHistory()
      else if (history.hasMore && history.error == null)
        OutlinedButton(
          onPressed: () => history.load(),
          child: const Text('加载更早版本'),
        )
      else if (history.error == null)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 18),
          child: _Hint(
            history.partial
                ? '当前仅展示近期发布及已保存记录；完整历史请查看官方下载页'
                : entries.isEmpty
                ? '暂无${switch (_filter) {
                    _HistoryFilter.all => '已发布版本',
                    _HistoryFilter.stable => '正式版记录',
                    _HistoryFilter.preview => '测试版记录',
                  }}'
                : '已展示全部已发布版本',
          ),
        ),
    ];
  }
}

class _VersionHero extends StatelessWidget {
  final AppUpdates updates;
  final bool compact;
  const _VersionHero({required this.updates, required this.compact});

  @override
  Widget build(BuildContext context) {
    final release = updates.available;
    final version = release?.version ?? updates.installed;
    final status = updates.downloading
        ? '正在下载'
        : updates.ready
        ? '更新已就绪'
        : updates.checking
        ? '正在检查'
        : release != null
        ? '发现新版本'
        : '当前版本';
    return Container(
      padding: EdgeInsets.all(compact ? 16 : 20),
      decoration: BoxDecoration(
        color: AppColors.night,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _Badge(status, highlighted: true),
                    SizedBox(height: compact ? 10 : 16),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Text(
                        version?.name ?? '—',
                        style: AppFont.ui(
                          size: compact ? 32 : 42,
                          weight: FontWeight.w600,
                          color: AppColors.onNight,
                        ),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      version == null
                          ? '正在读取版本'
                          : '${release != null ? (release.preview ? '测试版' : '正式版') : (updates.debugSigned ? '测试签名' : '已安装')} · build ${version.build}',
                      style: AppFont.ui(size: 13, color: AppColors.nightMuted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              SizedBox(
                width: MediaQuery.sizeOf(context).width < 360 ? 64 : 88,
                child: Image.asset(
                  'assets/ui-v3/mascot-avatar.png',
                  excludeFromSemantics: true,
                ),
              ),
            ],
          ),
          if (!compact && release != null) ...[
            const SizedBox(height: 22),
            if (updates.downloading) ...[
              LinearProgressIndicator(
                value: updates.progress,
                color: AppColors.lime,
                backgroundColor: AppColors.nightRaised,
                minHeight: 5,
                borderRadius: BorderRadius.circular(8),
              ),
              const SizedBox(height: 10),
              Text(
                updates.progress >= 1
                    ? '正在校验安装包…'
                    : '正在下载 ${(updates.progress * 100).toStringAsFixed(0)}%',
                style: AppFont.ui(color: AppColors.onNight),
              ),
              TextButton(
                onPressed: updates.cancel,
                style: TextButton.styleFrom(foregroundColor: AppColors.lime),
                child: const Text('取消下载'),
              ),
            ] else ...[
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.lime,
                    foregroundColor: AppColors.night,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 15,
                    ),
                  ),
                  onPressed: updates.busy
                      ? null
                      : updates.ready
                      ? updates.install
                      : () => updates.download(),
                  iconAlignment: IconAlignment.end,
                  icon: Icon(
                    updates.ready
                        ? Icons.install_mobile_rounded
                        : Icons.arrow_forward_rounded,
                    size: 20,
                  ),
                  label: Text(
                    updates.installing
                        ? '正在准备安装…'
                        : updates.ready
                        ? '安装更新'
                        : '下载更新 · ${release.sizeLabel}',
                  ),
                ),
              ),
              const SizedBox(height: 10),
              Center(
                child: Text(
                  '下载后由你确认安装',
                  style: AppFont.ui(size: 11, color: AppColors.nightMuted),
                ),
              ),
            ],
          ],
          if (!updates.supported) ...[
            const SizedBox(height: 12),
            Text(
              '当前平台可浏览历史，暂不支持应用内更新',
              style: AppFont.ui(size: 12, color: AppColors.nightMuted),
            ),
          ],
        ],
      ),
    );
  }
}

class _InstalledVersion extends StatelessWidget {
  final AppUpdates updates;
  final VoidCallback onCheck;
  const _InstalledVersion({required this.updates, required this.onCheck});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(14, 8, 4, 8),
    decoration: BoxDecoration(
      color: AppColors.halo.withValues(alpha: .55),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '当前安装',
                style: AppFont.ui(size: 11, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 3),
              Text(
                updates.installed?.label ?? '正在读取…',
                style: AppFont.ui(size: 12),
              ),
            ],
          ),
        ),
        TextButton(
          onPressed: updates.busy || !updates.supported ? null : onCheck,
          child: Text(updates.checking ? '正在检查…' : '检查更新'),
        ),
      ],
    ),
  );
}

class _HistoryCard extends StatelessWidget {
  final ReleaseHistoryEntry entry;
  final bool current, latest, expanded, last;
  final VoidCallback onToggle;
  const _HistoryCard({
    required this.entry,
    required this.current,
    required this.latest,
    required this.expanded,
    required this.last,
    required this.onToggle,
  });
  @override
  Widget build(BuildContext context) => Stack(
    children: [
      if (!last)
        const Positioned(
          left: 11.5,
          top: 33,
          bottom: 0,
          width: 1,
          child: ColoredBox(color: AppColors.borderWarm),
        ),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 24,
            child: Column(
              children: [
                const SizedBox(height: 23),
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: latest
                        ? AppColors.primaryDeep
                        : AppColors.textSecondaryLight,
                    shape: BoxShape.circle,
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: _Panel(
                padding: EdgeInsets.zero,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Semantics(
                      button: true,
                      expanded: expanded,
                      child: InkWell(
                        borderRadius: BorderRadius.circular(16),
                        onTap: onToggle,
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Expanded(
                                    child: Wrap(
                                      spacing: 8,
                                      runSpacing: 8,
                                      crossAxisAlignment:
                                          WrapCrossAlignment.center,
                                      children: [
                                        Text(
                                          entry.version,
                                          style: AppFont.ui(
                                            size: 21,
                                            weight: FontWeight.w600,
                                          ),
                                        ),
                                        if (latest)
                                          const _Badge('最新', highlighted: true),
                                        if (current) const _Badge('当前安装'),
                                        _Badge(entry.channelLabel),
                                      ],
                                    ),
                                  ),
                                  Icon(
                                    expanded
                                        ? Icons.expand_less_rounded
                                        : Icons.expand_more_rounded,
                                    color: AppColors.textSecondary,
                                  ),
                                ],
                              ),
                              const SizedBox(height: 10),
                              Text(
                                '${entry.dateLabel}${entry.build == null ? '' : ' · build ${entry.build}'}',
                                style: AppFont.ui(
                                  size: 11,
                                  color: AppColors.textSecondary,
                                ),
                              ),
                              const SizedBox(height: 8),
                              Text(
                                entry.summary,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: AppFont.ui(
                                  size: 13,
                                  color: AppColors.textSecondary,
                                  height: 1.5,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                    if (expanded)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Divider(height: 1),
                            const SizedBox(height: 16),
                            _ReleaseNotes(entry.notes),
                            if (entry.url != null)
                              _ReleaseLink(url: entry.url!),
                            TextButton(
                              onPressed: onToggle,
                              child: const Text('收起说明'),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    ],
  );
}

class _UpdatePreferences extends StatelessWidget {
  final AppUpdates updates;
  const _UpdatePreferences({required this.updates});
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: updates,
    builder: (context, _) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '更新偏好',
                    style: AppFont.ui(size: 22, weight: FontWeight.w600),
                  ),
                ),
                IconButton(
                  tooltip: '关闭',
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
            const SizedBox(height: 8),
            for (final option in [
              (
                'autoCheck',
                '自动检查更新',
                '启动或回到前台时检查，每 6 小时最多一次',
                updates.autoCheck,
              ),
              (
                'autoDownload',
                '自动下载更新',
                '应用运行时在非计费 Wi-Fi 下下载，安装前由你确认',
                updates.autoDownload,
              ),
              ('previews', '接收测试版', '开启后可下载安装预发布版本；不影响历史浏览', updates.previews),
            ])
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: Text(option.$2),
                subtitle: Text(option.$3),
                value: option.$4,
                onChanged: updates.busy || !updates.supported
                    ? null
                    : (value) => updates.setOption(option.$1, value),
              ),
            const Divider(height: 28),
            Text(
              '下载后会校验文件完整性和应用签名。首次安装需允许此应用安装更新，再由 Android 显示安装确认界面。',
              style: AppFont.ui(
                size: 12,
                color: AppColors.textSecondary,
                height: 1.6,
              ),
            ),
            if (updates.lastChecked != null) ...[
              const SizedBox(height: 12),
              Text(
                '上次检查：${updates.lastChecked!.toLocal().toString().substring(0, 16)}',
                style: AppFont.ui(size: 11, color: AppColors.textSecondary),
              ),
            ],
          ],
        ),
      ),
    ),
  );
}

class _Panel extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  const _Panel({required this.child, this.padding = const EdgeInsets.all(20)});
  @override
  Widget build(BuildContext context) => Material(
    color: AppColors.card,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(16),
      side: const BorderSide(color: AppColors.borderWarm),
    ),
    clipBehavior: Clip.antiAlias,
    child: Padding(padding: padding, child: child),
  );
}

class _Badge extends StatelessWidget {
  final String label;
  final bool highlighted;
  const _Badge(this.label, {this.highlighted = false});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
    decoration: BoxDecoration(
      color: highlighted ? AppColors.lime : AppColors.bg,
      borderRadius: BorderRadius.circular(20),
    ),
    child: Text(label, style: AppFont.ui(size: 11, weight: FontWeight.w500)),
  );
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: AppFont.ui(size: 12, color: AppColors.textSecondary),
    ),
  );
}

class _ReleaseNotes extends StatelessWidget {
  final String text;
  const _ReleaseNotes(this.text);
  @override
  Widget build(BuildContext context) => GptMarkdownTheme(
    gptThemeData: GptMarkdownTheme.of(context).copyWith(
      h1: AppFont.ui(size: 20, weight: FontWeight.w600),
      h2: AppFont.ui(size: 17, weight: FontWeight.w600),
      h3: AppFont.ui(size: 15, weight: FontWeight.w600),
      h4: AppFont.ui(size: 14, weight: FontWeight.w600),
      h5: AppFont.ui(size: 14, weight: FontWeight.w600),
      h6: AppFont.ui(size: 14, weight: FontWeight.w600),
      autoAddDividerLineAfterH1: false,
    ),
    child: SelectionArea(
      child: MarkdownText(text.trim().isEmpty ? '此版本未提供更新说明。' : text, size: 14),
    ),
  );
}

class _ReleaseLink extends StatelessWidget {
  final String url;
  final String label;
  const _ReleaseLink({required this.url, this.label = '在 GitHub 查看完整发布'});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 16),
    child: OutlinedButton.icon(
      onPressed: () => openMarkdownLink(context, url),
      icon: const Icon(Icons.open_in_new_rounded, size: 15),
      label: Text(label),
    ),
  );
}

class _LoadingHistory extends StatelessWidget {
  const _LoadingHistory();
  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.all(24),
    child: Center(
      child: SizedBox(
        width: 22,
        height: 22,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
    ),
  );
}

class _HistoryError extends StatelessWidget {
  final ReleaseHistory history;
  const _HistoryError({required this.history});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(history.error!, style: AppFont.ui(size: 13)),
          TextButton(
            onPressed: history.loading
                ? null
                : () => history.load(refresh: true),
            child: const Text('重新加载'),
          ),
        ],
      ),
    ),
  );
}
