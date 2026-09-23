import 'dart:async';
import 'package:flutter/foundation.dart'
    show kIsWeb, defaultTargetPlatform, TargetPlatform;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../services/api_service.dart';
import '../services/ws_service.dart';
import '../services/notifications/notification_service.dart';
import '../services/notifications/notification_factory.dart';
import '../services/live_update.dart';
import '../util.dart';
import 'settings.dart';

final notificationServiceProvider = Provider<NotificationService>((ref) {
  final s = createNotificationService();
  s.init();
  return s;
});

/// On Android the native foreground service is the single notification source
/// (done / approval / capsule) — Dart must NOT post local notifications there.
/// iOS / desktop keep the Dart-side path. (kIsWeb first: web has no dart:io.)
bool get _dartMayNotify =>
    kIsWeb || defaultTargetPlatform != TargetPlatform.android;

final apiServiceProvider = Provider<ApiService>((ref) {
  final settings = ref.watch(settingsProvider);
  return ApiService(settings.baseUrl, token: settings.token);
});

/// A message.send that came back failed (assistant.done ok:false): the
/// original user text is restored into the input box + error surfaced.
class FailedSend {
  final String text;
  final String? error;
  const FailedSend(this.text, this.error);
}

/// Per-session event history (REST history merged with live events), oldest...
/// newest order is handled by the caller. Returned newest-first.
///
/// Watches ONLY this session's liveEvents slice (select) so streaming deltas /
/// other sessions' traffic don't re-trigger the REST fetch (request storm).
final sessionEventsProvider = FutureProvider.family<List<TaskEvent>, String>((
  ref,
  sessionId,
) async {
  final api = ref.watch(apiServiceProvider);
  final live =
      ref.watch(monitorProvider.select((s) => s.liveEvents[sessionId])) ??
      const <TaskEvent>[];
  List<TaskEvent> history = const [];
  try {
    history = await api.getEvents(sessionId);
  } catch (_) {
    // Brand-new session (no transcript yet) or offline — live events only.
  }
  final byId = <int, TaskEvent>{};
  final noId = <TaskEvent>[];
  for (final e in [...live, ...history]) {
    if (e.id != null) {
      byId[e.id!] = e;
    } else {
      noId.add(e);
    }
  }
  final merged = [...byId.values, ...noId]
    ..sort((a, b) => (b.id ?? 0).compareTo(a.id ?? 0));
  return merged;
});

class MonitorState {
  final WsStatus status;
  final Map<String, Session> sessions;
  final Map<String, List<TaskEvent>> liveEvents;
  final Map<String, Project> serverProjects; // keyed projectId, from server
  final Map<String, Approval> approvals; // keyed approvalId, pending
  final Map<String, String> streaming; // sessionId -> live assistant text
  final Map<String, String?> streamingPhases;
  final Map<String, String?> streamingItems;
  final Map<String, String?> streamingTurns;
  final Map<String, String> pendingUser; // sessionId -> optimistic user text
  final Map<String, String>
  statusOverride; // projectId -> local status (e.g. rejected)
  final Map<String, FailedSend> failedSends; // sessionId -> failed message.send
  final Map<String, AgentInfo> agents;
  final String? commandError;

  const MonitorState({
    this.status = WsStatus.connecting,
    this.sessions = const {},
    this.liveEvents = const {},
    this.serverProjects = const {},
    this.approvals = const {},
    this.streaming = const {},
    this.streamingPhases = const {},
    this.streamingItems = const {},
    this.streamingTurns = const {},
    this.pendingUser = const {},
    this.statusOverride = const {},
    this.failedSends = const {},
    this.agents = const {},
    this.commandError,
  });

  MonitorState copyWith({
    WsStatus? status,
    Map<String, Session>? sessions,
    Map<String, List<TaskEvent>>? liveEvents,
    Map<String, Project>? serverProjects,
    Map<String, Approval>? approvals,
    Map<String, String>? streaming,
    Map<String, String?>? streamingPhases,
    Map<String, String?>? streamingItems,
    Map<String, String?>? streamingTurns,
    Map<String, String>? pendingUser,
    Map<String, String>? statusOverride,
    Map<String, FailedSend>? failedSends,
    Map<String, AgentInfo>? agents,
    String? commandError,
    bool clearCommandError = false,
  }) => MonitorState(
    status: status ?? this.status,
    sessions: sessions ?? this.sessions,
    liveEvents: liveEvents ?? this.liveEvents,
    serverProjects: serverProjects ?? this.serverProjects,
    approvals: approvals ?? this.approvals,
    streaming: streaming ?? this.streaming,
    streamingPhases: streamingPhases ?? this.streamingPhases,
    streamingItems: streamingItems ?? this.streamingItems,
    streamingTurns: streamingTurns ?? this.streamingTurns,
    pendingUser: pendingUser ?? this.pendingUser,
    statusOverride: statusOverride ?? this.statusOverride,
    failedSends: failedSends ?? this.failedSends,
    agents: agents ?? this.agents,
    commandError: clearCommandError ? null : commandError ?? this.commandError,
  );

  String? streamingFor(String sid) => streaming[sid];
  String? pendingUserFor(String sid) => pendingUser[sid];

  List<Session> get sortedSessions {
    final list = sessions.values.toList();
    list.sort((a, b) => (b.updatedAt ?? 0).compareTo(a.updatedAt ?? 0));
    return list;
  }

  /// Server-sent projects if available, otherwise derived from sessions by cwd.
  List<Project> get projects {
    List<Project> list;
    if (serverProjects.isNotEmpty) {
      final raw = serverProjects.values.toList();
      // attach any live PENDING approval not already embedded (dead/expired
      // approvals from a cold-start snapshot must not resurrect the project)
      list = raw.map((p) {
        if (p.pendingApproval != null) {
          // embedded one may itself be stale — drop it if no longer pending
          if (!p.pendingApproval!.isPending) return _withoutApproval(p);
          return p;
        }
        Approval? a;
        for (final ap in approvals.values) {
          if (!ap.isPending) continue;
          if (ap.projectId == p.projectId ||
              ap.projectId == p.cwd ||
              ap.sessionId == p.activeSessionId) {
            a = ap;
            break;
          }
        }
        return a == null ? p : _withApproval(p, a);
      }).toList();
      list.sort((a, b) => b.lastEventAt.compareTo(a.lastEventAt));
    } else {
      list = _deriveProjects();
    }
    if (statusOverride.isEmpty) return list;
    return list.map((p) {
      final ov = statusOverride[p.projectId];
      return ov == null || ov == p.status ? p : _withStatus(p, ov);
    }).toList();
  }

  Project _withApproval(Project p, Approval a) =>
      p.withState(status: 'needs_approval', approval: a);

  Project _withoutApproval(Project p) => p.withState(
    status: p.status == 'needs_approval' ? 'running' : p.status,
    clearApproval: true,
  );

  Project _withStatus(Project p, String status) => p.withState(status: status);

  List<Project> _deriveProjects() {
    final byCwd = <String, Session>{};
    for (final s in sessions.values) {
      final key = s.cwd ?? s.sessionId;
      final cur = byCwd[key];
      if (cur == null || (s.updatedAt ?? 0) > (cur.updatedAt ?? 0)) {
        byCwd[key] = s;
      }
    }
    final list = byCwd.entries.map((e) {
      final s = e.value;
      Approval? pending;
      for (final ap in approvals.values) {
        if (!ap.isPending) continue;
        if (ap.sessionId == s.sessionId) {
          pending = ap;
          break;
        }
      }
      return Project(
        projectId: e.key,
        name: projectNameFromCwd(s.cwd) ?? shortId(s.sessionId),
        cwd: s.cwd ?? '',
        status: pending != null ? 'needs_approval' : s.status,
        activeSessionId: s.sessionId,
        summary: s.summary,
        pendingApproval: pending,
        lastEventAt: s.updatedAt ?? 0,
      );
    }).toList();
    list.sort((a, b) => b.lastEventAt.compareTo(a.lastEventAt));
    return list;
  }

  List<Approval> get pendingApprovals =>
      approvals.values.where((a) => a.isPending).toList()
        ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
}

class MonitorNotifier extends Notifier<MonitorState> {
  final Set<String> _completedSessions = {};
  WsService? _ws;
  StreamSubscription? _msgSub;
  StreamSubscription? _statusSub;

  @override
  MonitorState build() {
    final settings = ref.watch(settingsProvider);
    ref.onDispose(_teardown);
    _start(settings);
    return const MonitorState();
  }

  void _start(ServerSettings settings) {
    _ws = WsService(settings.wsUrl);
    _statusSub = _ws!.status.listen((s) => state = state.copyWith(status: s));
    _msgSub = _ws!.messages.listen(_onMessage);
    _ws!.connect();
    _loadInitial();
    // Hand endpoints+token to the Android foreground service (the sole
    // Android notification source). Re-runs whenever settings change because
    // build() watches settingsProvider. No-op off Android.
    LiveUpdate.configureService(
      baseUrl: settings.baseUrl,
      wsUrl: settings.wsUrl,
      token: settings.token,
    );
  }

  void _teardown() {
    _msgSub?.cancel();
    _statusSub?.cancel();
    _ws?.dispose();
  }

  Future<void> _loadInitial() async {
    final api = ref.read(apiServiceProvider);
    try {
      final agents = await api.getAgents();
      state = state.copyWith(agents: {for (final a in agents) a.agentId: a});
    } catch (_) {
      /* Legacy bridges do not expose the registry. */
    }
    try {
      final sessions = await api.getSessions();
      state = state.copyWith(
        sessions: {for (final s in sessions) s.sessionId: s},
      );
    } catch (_) {
      /* offline; WS snapshot fills in */
    }
    try {
      final projects = await api.getProjects();
      if (projects.isNotEmpty) {
        state = state.copyWith(
          serverProjects: {for (final p in projects) p.projectId: p},
        );
      }
    } catch (_) {
      /* backend may not expose projects yet -> derive client-side */
    }
    try {
      final aps = await api.getApprovals();
      state = state.copyWith(approvals: {for (final a in aps) a.approvalId: a});
    } catch (_) {}
    _refreshLiveUpdate();
  }

  void _onMessage(Map<String, dynamic> msg) {
    switch (msg['type']) {
      case 'agents.snapshot':
        final agents = (msg['agents'] as List).map(
          (a) => AgentInfo.fromJson(a as Map<String, dynamic>),
        );
        state = state.copyWith(agents: {for (final a in agents) a.agentId: a});
        break;
      case 'approvals.snapshot':
        final approvals = (msg['approvals'] as List).map(
          (a) => Approval.fromJson(a as Map<String, dynamic>),
        );
        state = state.copyWith(
          approvals: {for (final a in approvals) a.approvalId: a},
        );
        break;
      case 'command.error':
        if (msg['operation'] != 'message.send') {
          state = state.copyWith(
            commandError: msg['error'] as String? ?? '操作失败',
          );
        }
        break;
      case 'command.result':
        if (msg['status'] == 'failed' && msg['operation'] != 'message.send') {
          final result = msg['result'] as Map?;
          state = state.copyWith(
            commandError: result?['error'] as String? ?? '操作失败',
          );
        }
        break;
      // ---- legacy session-level (back-compat) ----
      case 'snapshot':
        final list = (msg['sessions'] as List)
            .map((e) => Session.fromJson(e as Map<String, dynamic>))
            .toList();
        state = state.copyWith(
          sessions: {for (final s in list) s.sessionId: s},
        );
        break;
      case 'event':
        final session = Session.fromJson(
          msg['session'] as Map<String, dynamic>,
        );
        final ev = TaskEvent.fromJson(msg['event'] as Map<String, dynamic>);
        _applyEvent(session: session, ev: ev);
        break;
      // ---- v2 project / approval protocol ----
      case 'projects.snapshot':
        final list = (msg['projects'] as List)
            .map((e) => Project.fromJson(e as Map<String, dynamic>))
            .toList();
        state = state.copyWith(
          serverProjects: {for (final p in list) p.projectId: p},
        );
        _refreshLiveUpdate();
        break;
      case 'project.update':
        final p = Project.fromJson(msg['project'] as Map<String, dynamic>);
        final prev = state.serverProjects[p.projectId];
        final next = Map<String, Project>.from(state.serverProjects)
          ..[p.projectId] = p;
        // Clear a local status override (e.g. rejected) once the server sends
        // a real status transition for this project.
        var override = state.statusOverride;
        if (override.containsKey(p.projectId) &&
            prev != null &&
            prev.status != p.status) {
          override = Map<String, String>.from(override)..remove(p.projectId);
        }
        state = state.copyWith(serverProjects: next, statusOverride: override);
        // Only alert on a real transition into "done" (running/approval -> done),
        // not on the initial snapshot of already-finished projects, nor on
        // repeated done updates. (Android: native service owns notifications.)
        if (p.status == 'done' && prev != null && prev.status != 'done') {
          if (_dartMayNotify) {
            ref
                .read(notificationServiceProvider)
                .show('✅ 任务完成', p.summary ?? p.name, payload: p.projectId);
          }
        }
        _refreshLiveUpdate();
        break;
      case 'event.append':
        // Synthesized rows (e.g. ApprovalResolved outcome) — insert into the
        // live buffer; sessionEventsProvider watches that slice and refreshes.
        final ev = TaskEvent.fromJson(msg['event'] as Map<String, dynamic>);
        _applyEvent(ev: ev);
        break;
      case 'session.changed':
        // The transcript file changed — re-fetch that conversation from REST.
        final sid = msg['sessionId'] as String?;
        if (sid != null) ref.invalidate(sessionEventsProvider(sid));
        break;
      // ---- streaming reply (message.send -> claude -p) ----
      case 'assistant.start':
        _completedSessions.remove(msg['sessionId']);
        _setStreaming(
          msg['sessionId'] as String?,
          '',
          turnId: msg['turnId'] as String?,
        );
        break;
      case 'assistant.delta':
        _setStreaming(
          msg['sessionId'] as String?,
          msg['text'] as String? ?? '',
          phase: msg['phase'] as String?,
          itemId: msg['itemId'] as String?,
          turnId: msg['turnId'] as String?,
        );
        break;
      case 'assistant.done':
        final sid = msg['sessionId'] as String?;
        if (sid != null) {
          _completedSessions.add(sid);
          if (_completedSessions.length > 500) {
            _completedSessions.remove(_completedSessions.first);
          }
          final ok = msg['ok'] as bool? ?? true;
          final error = msg['error'] as String?;
          final st = Map<String, String>.from(state.streaming)..remove(sid);
          final pu = Map<String, String>.from(state.pendingUser);
          final userText = pu.remove(sid);
          var failed = state.failedSends;
          if (!ok) {
            // Surface the error + give the user their text back (input box).
            failed = Map<String, FailedSend>.from(failed)
              ..[sid] = FailedSend(userText ?? '', error);
          }
          state = state.copyWith(
            streaming: st,
            streamingPhases: Map.of(state.streamingPhases)..remove(sid),
            streamingItems: Map.of(state.streamingItems)..remove(sid),
            streamingTurns: Map.of(state.streamingTurns)..remove(sid),
            pendingUser: pu,
            failedSends: failed,
          );
          ref.invalidate(sessionEventsProvider(sid)); // pull the finalized turn
        }
        break;
      case 'approval.request':
        final a = Approval.fromJson(msg['approval'] as Map<String, dynamic>);
        final next = Map<String, Approval>.from(state.approvals)
          ..[a.approvalId] = a;
        state = state.copyWith(approvals: next);
        if (_dartMayNotify) {
          ref
              .read(notificationServiceProvider)
              .show('🔔 需要审批', a.title, payload: a.approvalId);
        }
        _refreshLiveUpdate();
        break;
      case 'approval.resolved':
        final id = msg['approvalId'] as String?;
        if (id != null) {
          final next = Map<String, Approval>.from(state.approvals)..remove(id);
          final projects = Map<String, Project>.from(state.serverProjects);
          for (final entry in projects.entries.toList()) {
            if (entry.value.pendingApproval?.approvalId == id) {
              projects[entry.key] = entry.value.withState(
                status: msg['decision'] == 'reject' ? 'rejected' : 'running',
                clearApproval: true,
              );
            }
          }
          state = state.copyWith(approvals: next, serverProjects: projects);
        }
        _refreshLiveUpdate();
        break;
    }
  }

  void _applyEvent({Session? session, required TaskEvent ev}) {
    final sessions = Map<String, Session>.from(state.sessions);
    if (session != null) sessions[session.sessionId] = session;
    final live = Map<String, List<TaskEvent>>.from(state.liveEvents);
    final buf = List<TaskEvent>.from(live[ev.sessionId] ?? const []);
    buf.insert(0, ev);
    if (buf.length > 300) buf.removeLast();
    live[ev.sessionId] = buf;
    state = state.copyWith(sessions: sessions, liveEvents: live);
    if (ev.status == 'done' && _dartMayNotify) {
      final s = session ?? state.sessions[ev.sessionId];
      ref
          .read(notificationServiceProvider)
          .show('✅ 任务完成', s?.summary ?? '任务已完成', payload: ev.sessionId);
    }
  }

  // ---- upstream (App -> server) ----

  Future<bool> respondApproval(
    String approvalId, {
    required bool approve,
    String scope = 'once',
    Map<String, String>? answers,
  }) async {
    final decision = approve ? 'approve' : 'reject';
    final sent = await ref
        .read(apiServiceProvider)
        .resolveApproval(
          approvalId,
          decision: decision,
          scope: scope,
          answers: answers,
        );
    if (!sent) state = state.copyWith(commandError: '审批未发送，请检查连接及 Agent 状态');
    return sent;
  }

  void clearCommandError() => state = state.copyWith(clearCommandError: true);

  void _setStreaming(
    String? sessionId,
    String text, {
    String? phase,
    String? itemId,
    String? turnId,
  }) {
    if (sessionId == null) return;
    final st = Map<String, String>.from(state.streaming)..[sessionId] = text;
    state = state.copyWith(
      streaming: st,
      streamingPhases: {...state.streamingPhases, sessionId: phase},
      streamingItems: {...state.streamingItems, sessionId: itemId},
      streamingTurns: {
        ...state.streamingTurns,
        sessionId: turnId ?? state.streamingTurns[sessionId],
      },
    );
  }

  /// Reflect the single most salient project onto the Android 16 Live Update
  /// capsule: an approval-waiting project wins over a merely-running one; if
  /// nothing is active the capsule is dismissed. No-op off Android.
  void _refreshLiveUpdate() {
    Project? approval;
    Project? running;
    for (final p in state.projects) {
      if (!p.online) continue;
      if (p.status == 'needs_approval') {
        approval ??= p;
      } else if (p.status == 'running') {
        running ??= p;
      }
    }
    final target = approval ?? running;
    if (target == null) {
      LiveUpdate.hide();
      return;
    }
    if (target.status == 'needs_approval') {
      LiveUpdate.show(
        title: '小梦 · ${target.name}',
        text: target.pendingApproval?.title ?? '需要你的审批',
        shortText: '待审批',
        status: target.status,
        progressDone: target.progress?.done,
        progressTotal: target.progress?.total,
      );
    } else {
      LiveUpdate.show(
        title: '小梦 · ${target.name}',
        text: target.summary ?? '运行中…',
        shortText: '运行中',
        status: target.status,
        progressDone: target.progress?.done,
        progressTotal: target.progress?.total,
      );
    }
  }

  /// Send a reply into a session. Returns false (and shows NO optimistic
  /// bubble) when the WebSocket is down — the caller surfaces "未连接".
  bool sendMessage(String sessionId, String text) {
    final sent =
        _ws?.send({
          'type': 'message.send',
          'sessionId': sessionId,
          'text': text,
        }) ??
        false;
    if (!sent) return false;
    // Optimistically show the user's message + a streaming placeholder.
    final pu = Map<String, String>.from(state.pendingUser)..[sessionId] = text;
    final st = Map<String, String>.from(state.streaming)..[sessionId] = '';
    state = state.copyWith(pendingUser: pu, streaming: st);
    return true;
  }

  bool steerMessage(String sessionId, String text) =>
      _ws?.send({
        'type': 'message.steer',
        'sessionId': sessionId,
        'text': text,
      }) ??
      false;

  /// Prime the optimistic bubbles for a session just created via REST
  /// (POST /api/projects/:id/sessions) — the streamed reply arrives over WS.
  void primeNewSession(String sessionId, String text) {
    // A fast worker can finish before the HTTP create response reaches the UI.
    if (_completedSessions.contains(sessionId)) return;
    final pu = Map<String, String>.from(state.pendingUser)..[sessionId] = text;
    final st = Map<String, String>.from(state.streaming)..[sessionId] = '';
    state = state.copyWith(pendingUser: pu, streaming: st);
  }

  /// Consume (clear) a failed-send record once the UI has restored the text.
  void clearFailedSend(String sessionId) {
    if (!state.failedSends.containsKey(sessionId)) return;
    final failed = Map<String, FailedSend>.from(state.failedSends)
      ..remove(sessionId);
    state = state.copyWith(failedSends: failed);
  }

  void sessionControl(String sessionId, String action) {
    _ws?.send({
      'type': 'session.control',
      'sessionId': sessionId,
      'action': action,
    });
  }

  void reconnect() {
    _teardown();
    state = state.copyWith(status: WsStatus.connecting);
    _start(ref.read(settingsProvider));
  }
}

final monitorProvider = NotifierProvider<MonitorNotifier, MonitorState>(
  MonitorNotifier.new,
);

/// Convenience: a single project by id (server or derived).
final projectProvider = Provider.family<Project?, String>((ref, projectId) {
  ref.watch(monitorProvider.select((s) => s.serverProjects[projectId]));
  ref.watch(monitorProvider.select((s) => s.approvals));
  final projects = ref.read(monitorProvider).projects;
  for (final p in projects) {
    if (p.projectId == projectId) return p;
  }
  return null;
});
