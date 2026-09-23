import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/monitor.dart';
import '../services/ws_service.dart';
import '../theme/tokens.dart';
import '../util.dart';
import '../widgets/mascot.dart';
import '../widgets/studio_widgets.dart';
import '../widgets/dream_motion.dart';
import '../widgets/status_chip.dart';
import '../widgets/studio_icon.dart';
import '../widgets/studio_sidebar.dart';
import '../widgets/approval_drawer.dart';
import 'agents_screen.dart';
import 'project_detail_screen.dart';
import 'settings_screen.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});
  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  final _search = TextEditingController();
  final _scroll = ScrollController();
  bool _heroVisible = true;
  final _scaffold = GlobalKey<ScaffoldState>();
  String _view = '会话';
  String _filter = '全部';
  String? _projectId;
  String? _agentId;
  Project? _openedProject;
  String? _openedSession;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_updateHeroVisibility);
  }

  void _updateHeroVisibility() {
    if (!mounted || !_scroll.hasClients) return;
    final visible = _scroll.offset < 380;
    if (visible != _heroVisible) setState(() => _heroVisible = visible);
  }

  @override
  void dispose() {
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _navigate(String view) {
    setState(() {
      _view = view;
      _projectId = null;
      _openedProject = null;
      _search.clear();
    });
    _scaffold.currentState?.closeDrawer();
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _updateHeroVisibility(),
    );
  }

  void _open(Project project, String? sessionId, bool wide) {
    if (wide) {
      setState(() {
        _openedProject = project;
        _openedSession = sessionId;
      });
    } else {
      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => ProjectDetailScreen(
            projectId: project.projectId,
            sessionId: sessionId,
          ),
        ),
      );
    }
  }

  Future<void> _agents() async {
    _scaffold.currentState?.closeDrawer();
    final id = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (_) => const AgentsScreen()),
    );
    if (id != null && mounted) {
      setState(() {
        _agentId = id.isEmpty ? null : id;
        _openedProject = null;
      });
    }
  }

  Future<void> _newChat(List<Project> projects, bool wide) async {
    final available = projects
        .where((p) => p.can('session.start') && p.online)
        .toList();
    if (available.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('请先连接一个支持新建会话的 Agent')));
      return;
    }
    final input = TextEditingController();
    final selected =
        available.where((p) => p.projectId == _projectId).firstOrNull ??
        available.first;
    var project = selected;
    var busy = false;
    String? error;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: AppColors.card,
      constraints: const BoxConstraints(maxWidth: 640),
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, update) => SafeArea(
          child: SingleChildScrollView(
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                24,
                4,
                24,
                24 + MediaQuery.viewInsetsOf(sheet).bottom,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const MascotImage(MascotMood.avatar, size: 32),
                      const SizedBox(width: 10),
                      Text(
                        '开启新会话',
                        style: AppFont.ui(size: 20, weight: FontWeight.w600),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  DropdownButtonFormField<String>(
                    initialValue: project.projectId,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: '在哪个项目中工作',
                      border: OutlineInputBorder(),
                    ),
                    items: available
                        .map(
                          (p) => DropdownMenuItem(
                            value: p.projectId,
                            child: Text(
                              '${p.name} · ${p.agentName}',
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        )
                        .toList(),
                    onChanged: busy
                        ? null
                        : (id) => update(() {
                            project = available.firstWhere(
                              (p) => p.projectId == id,
                            );
                          }),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: input,
                    minLines: 3,
                    maxLines: 7,
                    autofocus: true,
                    enabled: !busy,
                    decoration: const InputDecoration(
                      hintText: '想让 Agent 帮你做什么？',
                      filled: true,
                      fillColor: AppColors.warmWhite,
                      border: OutlineInputBorder(borderSide: BorderSide.none),
                    ),
                  ),
                  if (error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Text(
                        error!,
                        style: AppFont.ui(color: AppColors.danger),
                      ),
                    ),
                  const SizedBox(height: 18),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: busy
                          ? null
                          : () async {
                              if (input.text.trim().isEmpty) return;
                              update(() {
                                busy = true;
                                error = null;
                              });
                              final text = input.text.trim();
                              final sid = await ref
                                  .read(apiServiceProvider)
                                  .createSession(project.projectId, text);
                              if (!sheet.mounted) return;
                              if (sid == null) {
                                update(() {
                                  busy = false;
                                  error = '创建失败，请检查主机状态后重试。';
                                });
                                return;
                              }
                              ref
                                  .read(monitorProvider.notifier)
                                  .primeNewSession(sid, text);
                              Navigator.pop(sheet);
                              if (mounted) _open(project, sid, wide);
                            },
                      icon: busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.arrow_upward_rounded, size: 18),
                      label: Text(busy ? '正在连接主机…' : '发送并开始'),
                      style: FilledButton.styleFrom(
                        padding: const EdgeInsets.all(18),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    Future.delayed(const Duration(milliseconds: 350), input.dispose);
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(monitorProvider.select((s) => s.serverProjects));
    ref.watch(monitorProvider.select((s) => s.agents));
    ref.watch(monitorProvider.select((s) => s.approvals));
    final status = ref.watch(monitorProvider.select((s) => s.status));
    final monitor = ref.read(monitorProvider);
    final projects = monitor.projects
        .where((p) => _agentId == null || p.agentId == _agentId)
        .toList();
    final wide = MediaQuery.sizeOf(context).width >= 1000;
    final online = monitor.agents.values.where((a) => a.online).length;
    final total = projects.fold<int>(0, (n, p) => n + p.sessions.length);
    final saved = projects.where((p) => p.saved).toList();
    final isHome = _view == '会话' && _projectId == null && _agentId == null;
    final sidebar = _sidebar(
      saved.isEmpty ? projects : saved,
      wide,
      online,
      status,
    );
    return Scaffold(
      key: _scaffold,
      backgroundColor: AppColors.bg,
      drawer: wide
          ? null
          : Drawer(
              width: MediaQuery.sizeOf(context).width * .82,
              shape: const RoundedRectangleBorder(),
              backgroundColor: AppColors.night,
              child: SafeArea(child: sidebar),
            ),
      bottomNavigationBar: wide
          ? null
          : DreamNavigation(
              selectedIndex: _view == '项目'
                  ? 1
                  : _view == '待处理'
                  ? 2
                  : _view == '已归档'
                  ? 3
                  : 0,
              pending: monitor.approvals.values
                  .where((a) => a.isPending)
                  .length,
              onSelected: (index) {
                _navigate(['会话', '项目', '待处理', '已归档'][index]);
              },
            ),
      body: SafeArea(
        bottom: false,
        child: Row(
          children: [
            if (wide) SizedBox(width: 256, child: sidebar),
            Expanded(
              child: _openedProject != null && wide
                  ? Row(
                      children: [
                        SizedBox(
                          width: 340,
                          child: Column(
                            children: [
                              Padding(
                                padding: const EdgeInsets.all(24),
                                child: Row(
                                  children: [
                                    Text(
                                      '会话',
                                      style: AppFont.ui(
                                        size: 23,
                                        weight: FontWeight.w600,
                                      ),
                                    ),
                                    const Spacer(),
                                    IconButton(
                                      tooltip: '新会话',
                                      onPressed: () => _newChat(projects, true),
                                      icon: const Icon(Icons.add_rounded),
                                    ),
                                  ],
                                ),
                              ),
                              Expanded(
                                child: CustomScrollView(
                                  slivers: [
                                    SliverPadding(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 16,
                                        vertical: 8,
                                      ),
                                      sliver: _sessionList(projects, true),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                        const VerticalDivider(width: 1),
                        Expanded(
                          child: ProjectDetailScreen(
                            key: ValueKey(
                              '${_openedProject!.projectId}:$_openedSession',
                            ),
                            projectId: _openedProject!.projectId,
                            sessionId: _openedSession,
                            onBack: () => setState(() => _openedProject = null),
                          ),
                        ),
                      ],
                    )
                  : Column(
                      children: [
                        ColoredBox(
                          color: isHome ? AppColors.night : AppColors.bg,
                          child: Padding(
                            padding: EdgeInsets.fromLTRB(
                              wide ? 32 : 20,
                              12,
                              wide ? 32 : 16,
                              10,
                            ),
                            child: Row(
                              children: [
                                const MascotImage(MascotMood.avatar, size: 30),
                                const SizedBox(width: 10),
                                Text(
                                  '小梦',
                                  style: AppFont.ui(
                                    size: 22,
                                    weight: FontWeight.w700,
                                    color: isHome
                                        ? AppColors.onNight
                                        : AppColors.ink,
                                  ),
                                ),
                                const Spacer(),
                                ConnectionPill(
                                  label: status == WsStatus.connected
                                      ? '$online 在线'
                                      : '未连接',
                                  online:
                                      status == WsStatus.connected &&
                                      online > 0,
                                  onTap: _agents,
                                  dark: isHome,
                                ),
                                const SizedBox(width: 8),
                                IconButton(
                                  tooltip: wide ? '刷新任务' : '打开导航',
                                  onPressed: wide
                                      ? () => ref
                                            .read(monitorProvider.notifier)
                                            .reconnect()
                                      : () => _scaffold.currentState
                                            ?.openDrawer(),
                                  style: IconButton.styleFrom(
                                    foregroundColor: isHome
                                        ? AppColors.onNight
                                        : AppColors.ink,
                                    backgroundColor: isHome
                                        ? AppColors.nightRaised
                                        : AppColors.card,
                                  ),
                                  icon: Icon(
                                    wide
                                        ? Icons.refresh_rounded
                                        : Icons.menu_rounded,
                                    size: 21,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        Expanded(
                          child: RefreshIndicator(
                            color: AppColors.success,
                            onRefresh: () async =>
                                ref.read(monitorProvider.notifier).reconnect(),
                            child: CustomScrollView(
                              controller: _scroll,
                              physics: const AlwaysScrollableScrollPhysics(),
                              key: PageStorageKey(
                                'workspace:$_view:$_projectId:$_filter',
                              ),
                              slivers: [
                                if (isHome && _search.text.isEmpty)
                                  SliverToBoxAdapter(
                                    child: TickerMode(
                                      enabled: _heroVisible,
                                      child: StudioHero(
                                        onStart: () => _newChat(projects, wide),
                                      ),
                                    ),
                                  ),
                                SliverPadding(
                                  padding: EdgeInsets.fromLTRB(
                                    wide ? 42 : 24,
                                    24,
                                    wide ? 42 : 24,
                                    0,
                                  ),
                                  sliver: SliverToBoxAdapter(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Row(
                                          children: [
                                            Expanded(
                                              child: Text(
                                                _view == '项目'
                                                    ? '项目'
                                                    : _view == '已归档'
                                                    ? '归档'
                                                    : _view == '待处理'
                                                    ? '收件箱'
                                                    : '最近会话',
                                                style: AppFont.ui(
                                                  size: 23,
                                                  weight: FontWeight.w700,
                                                  letterSpacing: -.6,
                                                ),
                                              ),
                                            ),
                                            if (_view == '会话')
                                              FilledButton.icon(
                                                onPressed: () =>
                                                    _newChat(projects, wide),
                                                icon: const Icon(
                                                  Icons.add_rounded,
                                                  size: 18,
                                                ),
                                                label: const Text('新会话'),
                                                style: FilledButton.styleFrom(
                                                  padding:
                                                      const EdgeInsets.symmetric(
                                                        horizontal: 15,
                                                        vertical: 12,
                                                      ),
                                                  shape: RoundedRectangleBorder(
                                                    borderRadius:
                                                        BorderRadius.circular(
                                                          AppRadii.button,
                                                        ),
                                                  ),
                                                ),
                                              ),
                                          ],
                                        ),
                                        if (_view == '项目') ...[
                                          const SizedBox(height: 6),
                                          Text(
                                            '想法有了自己的空间。',
                                            style: AppFont.ui(
                                              size: 13,
                                              color: AppColors.textSecondary,
                                            ),
                                          ),
                                        ],
                                        const SizedBox(height: 18),
                                        if (!isHome) ...[
                                          DreamPageIntro(
                                            dark: _view == '项目',
                                            motionActive: _heroVisible,
                                            motionScene: _view == '项目'
                                                ? BlenderIntroScene.project
                                                : _view == '待处理'
                                                ? BlenderIntroScene.inbox
                                                : _view == '已归档'
                                                ? BlenderIntroScene.archive
                                                : null,
                                            art: _view == '项目'
                                                ? 'assets/ui-v3/project-art.png'
                                                : _view == '待处理'
                                                ? 'assets/ui-v3/inbox-art.png'
                                                : _view == '已归档'
                                                ? 'assets/ui-v3/archive-art.png'
                                                : null,
                                            title: _view == '项目'
                                                ? '正在发生'
                                                : _view == '待处理'
                                                ? '重要的事，\n都在这里。'
                                                : _view == '已归档'
                                                ? '灵感，值得珍藏。'
                                                : '继续你的灵感。',
                                            subtitle: _view == '待处理'
                                                ? '待审批、待回复与需要关注的任务'
                                                : '$total 个会话 · ${projects.length} 个项目',
                                            icon: _view == '项目'
                                                ? Icons.folder_open_rounded
                                                : _view == '待处理'
                                                ? Icons
                                                      .mark_email_unread_outlined
                                                : Icons.inventory_2_outlined,
                                          ),
                                          const SizedBox(height: 18),
                                        ],
                                        TextField(
                                          controller: _search,
                                          onChanged: (_) => setState(() {}),
                                          style: AppFont.ui(size: 13),
                                          decoration: InputDecoration(
                                            hintText: _view == '项目'
                                                ? '搜索项目'
                                                : '搜索会话或项目',
                                            prefixIcon: const Icon(
                                              Icons.search_rounded,
                                              size: 22,
                                            ),
                                            suffixIcon: _search.text.isEmpty
                                                ? null
                                                : IconButton(
                                                    tooltip: '清除搜索',
                                                    onPressed: () =>
                                                        setState(_search.clear),
                                                    icon: const Icon(
                                                      Icons.close_rounded,
                                                      size: 18,
                                                    ),
                                                  ),
                                            fillColor: AppColors.timestampBg,
                                            contentPadding:
                                                const EdgeInsets.symmetric(
                                                  vertical: 14,
                                                ),
                                            border: OutlineInputBorder(
                                              borderRadius:
                                                  BorderRadius.circular(
                                                    AppRadii.input,
                                                  ),
                                              borderSide: BorderSide.none,
                                            ),
                                            enabledBorder: OutlineInputBorder(
                                              borderRadius:
                                                  BorderRadius.circular(
                                                    AppRadii.input,
                                                  ),
                                              borderSide: BorderSide.none,
                                            ),
                                          ),
                                        ),
                                        if (_agentId != null ||
                                            _projectId != null)
                                          Padding(
                                            padding: const EdgeInsets.only(
                                              top: 12,
                                            ),
                                            child: InputChip(
                                              deleteButtonTooltipMessage:
                                                  _agentId != null
                                                  ? '显示全部 Agent'
                                                  : '显示全部项目',
                                              label: Text(
                                                _projectId != null
                                                    ? projects
                                                              .where(
                                                                (p) =>
                                                                    p.projectId ==
                                                                    _projectId,
                                                              )
                                                              .firstOrNull
                                                              ?.name ??
                                                          '当前项目'
                                                    : '当前 Agent',
                                              ),
                                              onDeleted: () => setState(() {
                                                _projectId = null;
                                                _agentId = null;
                                              }),
                                            ),
                                          ),
                                        if (_view == '会话')
                                          Padding(
                                            padding: const EdgeInsets.symmetric(
                                              vertical: 16,
                                            ),
                                            child: Wrap(
                                              spacing: 8,
                                              runSpacing: 6,
                                              children: [
                                                for (final filter in [
                                                  '全部',
                                                  '运行中',
                                                  '待回复',
                                                ])
                                                  ChoiceChip(
                                                    label: Text(filter),
                                                    selected: _filter == filter,
                                                    showCheckmark: false,
                                                    onSelected: (_) => setState(
                                                      () => _filter = filter,
                                                    ),
                                                    shape: RoundedRectangleBorder(
                                                      borderRadius:
                                                          BorderRadius.circular(
                                                            AppRadii.badge,
                                                          ),
                                                    ),
                                                    side: BorderSide.none,
                                                    selectedColor:
                                                        AppColors.night,
                                                    backgroundColor:
                                                        AppColors.timestampBg,
                                                    padding:
                                                        const EdgeInsets.symmetric(
                                                          horizontal: 13,
                                                          vertical: 7,
                                                        ),
                                                    labelStyle: AppFont.ui(
                                                      size: 12,
                                                      weight: FontWeight.w500,
                                                      color: _filter == filter
                                                          ? AppColors.onNight
                                                          : AppColors
                                                                .textSecondary,
                                                    ),
                                                  ),
                                              ],
                                            ),
                                          )
                                        else
                                          const SizedBox(height: 20),
                                      ],
                                    ),
                                  ),
                                ),
                                SliverPadding(
                                  padding: EdgeInsets.fromLTRB(
                                    wide ? 42 : 24,
                                    0,
                                    wide ? 42 : 24,
                                    28,
                                  ),
                                  sliver: _view == '项目'
                                      ? _projectList(projects, wide)
                                      : _sessionList(projects, wide),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sidebar(
    List<Project> projects,
    bool wide,
    int online,
    WsStatus status,
  ) => StudioSidebar(
    projects: projects,
    selectedView: _openedProject == null ? _view : null,
    selectedProject: _projectId,
    online: online,
    connected: status == WsStatus.connected,
    pending: ref
        .read(monitorProvider)
        .approvals
        .values
        .where((a) => a.isPending)
        .length,
    onNavigate: _navigate,
    onNewChat: () {
      _scaffold.currentState?.closeDrawer();
      _newChat(projects, wide);
    },
    onProject: (project) {
      setState(() {
        _view = '会话';
        _projectId = project.projectId;
        _openedProject = null;
        _filter = '全部';
        _search.clear();
      });
      _scaffold.currentState?.closeDrawer();
    },
    onAgents: _agents,
    onSettings: () {
      _scaffold.currentState?.closeDrawer();
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => const SettingsScreen()),
      );
    },
  );

  Widget _projectList(List<Project> projects, bool wide) {
    final query = _search.text.trim().toLowerCase();
    final list =
        projects
            .where((p) => '${p.name} ${p.cwd}'.toLowerCase().contains(query))
            .toList()
          ..sort(
            (a, b) => a.saved == b.saved
                ? b.lastEventAt.compareTo(a.lastEventAt)
                : a.saved
                ? -1
                : 1,
          );
    if (list.isEmpty) return _empty('没有找到匹配的项目');
    return SliverLayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.crossAxisExtent >= 720
            ? 3
            : constraints.crossAxisExtent >= 330
            ? 2
            : 1;
        final textScale = MediaQuery.textScalerOf(context).scale(1);
        final cardWidth =
            (constraints.crossAxisExtent - (columns - 1) * 14) / columns;
        return SliverGrid.builder(
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: columns,
            crossAxisSpacing: 14,
            mainAxisSpacing: 14,
            mainAxisExtent:
                cardWidth / 1.5 + 124 + (textScale - 1).clamp(0, 2) * 76,
          ),
          itemCount: list.length,
          itemBuilder: (_, i) {
            final p = list[i];
            final cover =
                p.projectId.codeUnits
                    .fold<int>(0, (sum, unit) => sum + unit)
                    .isEven
                ? 'studio'
                : 'orbit';
            final pending = p.sessions
                .where(
                  (s) =>
                      !s.archived &&
                      (s.status == 'needs_approval' ||
                          s.status == 'waiting_input' ||
                          p.pendingApproval?.sessionId == s.sessionId),
                )
                .length;
            final running = p.sessions
                .where((s) => !s.archived && s.status == 'running')
                .length;
            final statusLabel = !p.online
                ? '离线 · ${p.sessionCount} 个会话'
                : pending > 0
                ? '$pending 项待确认'
                : running > 0
                ? '$running 个会话进行中'
                : '${p.sessionCount} 个会话';
            return DreamPress(
              child: Material(
                color: AppColors.card,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(AppRadii.card),
                  side: const BorderSide(color: AppColors.borderWarm),
                ),
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: () => setState(() {
                    _view = '会话';
                    _projectId = p.projectId;
                    _search.clear();
                    _filter = '全部';
                  }),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      AspectRatio(
                        aspectRatio: 1.5,
                        child: Image.asset(
                          'assets/ui-v3/project-ip-$cover.png',
                          fit: BoxFit.cover,
                          excludeFromSemantics: true,
                        ),
                      ),
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.all(14),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                p.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppFont.ui(
                                  size: 16,
                                  weight: FontWeight.w600,
                                ),
                              ),
                              const SizedBox(height: 5),
                              Text(
                                p.cwd,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppFont.ui(
                                  size: 10,
                                  color: AppColors.textSecondary,
                                ),
                              ),
                              const Spacer(),
                              Row(
                                children: [
                                  DreamActivityDot(
                                    active: p.online && running > 0,
                                    color: !p.online
                                        ? AppColors.textPlaceholder
                                        : pending > 0
                                        ? const Color(0xFFBE8A26)
                                        : AppColors.success,
                                  ),
                                  const SizedBox(width: 6),
                                  Expanded(
                                    child: Text(
                                      statusLabel,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: AppFont.ui(
                                        size: 11,
                                        color: AppColors.textSecondary,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _sessionList(List<Project> projects, bool wide) {
    final query = _search.text.trim().toLowerCase();
    final rows = <(Project, Session)>[];
    for (final p in projects) {
      if (_projectId != null && p.projectId != _projectId) continue;
      for (final s in p.sessions) {
        if ((_view == '已归档') != s.archived) continue;
        if (_view == '待处理' &&
            ![
              'needs_approval',
              'waiting_input',
              'error',
              'rejected',
            ].contains(s.status) &&
            p.pendingApproval?.sessionId != s.sessionId) {
          continue;
        }
        if (_view == '会话' && _filter == '运行中' && s.status != 'running') {
          continue;
        }
        if (_view == '会话' &&
            _filter == '待回复' &&
            !['waiting_input', 'needs_approval'].contains(s.status)) {
          continue;
        }
        if (!'${s.summary} ${p.name} ${s.model}'.toLowerCase().contains(
          query,
        )) {
          continue;
        }
        rows.add((p, s));
      }
    }
    rows.sort((a, b) {
      if (a.$2.pinned != b.$2.pinned) return a.$2.pinned ? -1 : 1;
      return (b.$2.updatedAt ?? 0).compareTo(a.$2.updatedAt ?? 0);
    });
    if (rows.isEmpty) {
      return _empty(
        _search.text.isNotEmpty
            ? '没有找到匹配的会话'
            : _view == '待处理'
            ? '暂时没有需要处理的任务'
            : '这里还没有会话',
      );
    }
    return SliverList.separated(
      itemCount: rows.length,
      separatorBuilder: (_, _) => const SizedBox(height: 9),
      itemBuilder: (_, i) {
        final (p, s) = rows[i];
        final waiting =
            p.pendingApproval?.sessionId == s.sessionId ||
            s.status == 'needs_approval';
        return DreamPress(
          child: Material(
            color: AppColors.card,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadii.card),
              side: BorderSide(
                color: waiting ? AppColors.peach : AppColors.borderWarm,
              ),
            ),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: () => _open(p, s.sessionId, wide),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        StudioIcon(
                          s.archived
                              ? StudioSymbol.archive
                              : waiting
                              ? StudioSymbol.inbox
                              : StudioSymbol.conversations,
                          size: 34,
                        ),
                        const SizedBox(width: 13),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                s.summary?.isNotEmpty == true
                                    ? s.summary!
                                    : '未命名会话',
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: AppFont.ui(
                                  size: 15,
                                  weight: FontWeight.w600,
                                  height: 1.4,
                                ),
                              ),
                              const SizedBox(height: 6),
                              Text(
                                '${p.name} · ${p.agentName}${s.source == 'subagent' ? ' · 子任务' : ''}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppFont.ui(
                                  size: 11,
                                  color: AppColors.textSecondary,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 4),
                        const Icon(
                          Icons.arrow_outward_rounded,
                          size: 16,
                          color: AppColors.textPlaceholder,
                        ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        DreamStatusSwitcher(
                          child: StatusChip(
                            waiting ? 'needs_approval' : s.status,
                            key: ValueKey(waiting ? 'approval' : s.status),
                          ),
                        ),
                        const Spacer(),
                        Text(
                          timeAgo(s.updatedAt),
                          style: AppFont.ui(
                            size: 10,
                            color: AppColors.textPlaceholder,
                          ),
                        ),
                      ],
                    ),
                    if (_view == '待处理' &&
                        p.pendingApproval?.sessionId == s.sessionId) ...[
                      const SizedBox(height: 16),
                      if (p.pendingApproval?.command != null)
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: AppColors.night,
                            borderRadius: BorderRadius.circular(AppRadii.tool),
                          ),
                          child: Text(
                            p.pendingApproval!.command!,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: AppFont.mono(
                              size: 12,
                              color: AppColors.lime,
                              height: 1.6,
                            ),
                          ),
                        ),
                      const SizedBox(height: 12),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: () => showApprovalDrawer(
                            context,
                            ref,
                            p.pendingApproval!,
                          ),
                          icon: const Icon(Icons.shield_outlined, size: 18),
                          label: const Text('查看并处理请求'),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _empty(String label) => SliverFillRemaining(
    hasScrollBody: false,
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const MascotImage(MascotMood.idle, size: 90),
          const SizedBox(height: 14),
          Text(
            label,
            style: AppFont.ui(size: 14, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 8),
          Text(
            '可以切换筛选，或开启一段新会话。',
            style: AppFont.ui(size: 12, color: AppColors.textPlaceholder),
          ),
        ],
      ),
    ),
  );
}
