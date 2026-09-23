// Data models mirroring the bridge server. snake_case JSON -> camelCase Dart.

/// A session belonging to one agent; IDs are scoped by the platform.
class Session {
  final String sessionId;
  final String? cwd;
  final String status;
  final String? lastEvent;
  final String? lastTool;
  final String? summary;
  final int? startedAt;
  final int? updatedAt;
  final List<String>? capabilities;
  final String? controlReason;
  final bool archived;
  final bool pinned;
  final String? model;
  final String? source;
  final String? reasoningEffort;
  final String? mode;
  final String? controlTransport;

  const Session({
    required this.sessionId,
    this.cwd,
    required this.status,
    this.lastEvent,
    this.lastTool,
    this.summary,
    this.startedAt,
    this.updatedAt,
    this.capabilities,
    this.controlReason,
    this.archived = false,
    this.pinned = false,
    this.model,
    this.source,
    this.reasoningEffort,
    this.mode,
    this.controlTransport,
  });

  factory Session.fromJson(Map<String, dynamic> j) => Session(
    sessionId: j['session_id'] as String,
    cwd: j['cwd'] as String?,
    status: (j['status'] as String?) ?? 'running',
    lastEvent: j['last_event'] as String?,
    lastTool: j['last_tool'] as String?,
    summary: j['summary'] as String?,
    startedAt: (j['started_at'] as num?)?.toInt(),
    updatedAt: (j['updated_at'] as num?)?.toInt(),
    capabilities: (j['capabilities'] as List?)?.cast<String>(),
    controlReason: j['controlReason'] as String?,
    archived: j['archived'] == true,
    pinned: j['pinned'] == true,
    model: j['model'] as String?,
    source: j['source'] as String?,
    reasoningEffort: j['reasoningEffort'] as String?,
    mode: j['mode'] as String?,
    controlTransport: j['controlTransport'] as String?,
  );
}

/// One hook event = one row on the conversation timeline.
class TaskEvent {
  final int? id;
  final String? eventKey;
  final String sessionId;
  final String hookEventName;
  final String? toolName;
  final String? toolCallId;
  final String? toolInput;
  final String? turnId;
  final String? itemId;
  final String? phase;
  final String status;
  final String? summary;
  final String? detail; // command text / file path / output line
  final bool? ok; // tool success (null = unknown / n/a)
  final int? createdAt;

  const TaskEvent({
    this.id,
    this.eventKey,
    required this.sessionId,
    required this.hookEventName,
    this.toolName,
    this.toolCallId,
    this.toolInput,
    this.turnId,
    this.itemId,
    this.phase,
    required this.status,
    this.summary,
    this.detail,
    this.ok,
    this.createdAt,
  });

  factory TaskEvent.fromJson(Map<String, dynamic> j) => TaskEvent(
    id: (j['id'] as num?)?.toInt(),
    eventKey: j['event_key'] as String?,
    sessionId: j['session_id'] as String,
    hookEventName: (j['hook_event_name'] as String?) ?? 'Unknown',
    toolName: j['tool_name'] as String?,
    toolCallId: j['tool_call_id'] as String?,
    toolInput: j['tool_input'] as String?,
    turnId: j['turn_id'] as String?,
    itemId: j['item_id'] as String?,
    phase: j['phase'] as String?,
    status: (j['status'] as String?) ?? 'running',
    summary: j['summary'] as String?,
    detail: j['detail'] as String?,
    ok: j['ok'] as bool?,
    createdAt: (j['created_at'] as num?)?.toInt(),
  );
}

class ProjectProgress {
  final int done;
  final int total;
  const ProjectProgress(this.done, this.total);
  double get fraction => total <= 0 ? 0 : (done / total).clamp(0, 1).toDouble();
  factory ProjectProgress.fromJson(Map<String, dynamic> j) => ProjectProgress(
    (j['done'] as num?)?.toInt() ?? 0,
    (j['total'] as num?)?.toInt() ?? 0,
  );
}

class AgentInfo {
  final String agentId;
  final String name;
  final String provider;
  final String nodeId;
  final String nodeName;
  final bool online;
  final List<String> capabilities;

  const AgentInfo({
    required this.agentId,
    required this.name,
    required this.provider,
    required this.nodeId,
    required this.nodeName,
    required this.online,
    this.capabilities = const [],
  });

  factory AgentInfo.fromJson(Map<String, dynamic> j) => AgentInfo(
    agentId: j['agentId'] as String,
    name: j['name'] as String? ?? 'Agent',
    provider: j['provider'] as String? ?? 'custom',
    nodeId: j['nodeId'] as String? ?? '',
    nodeName: j['nodeName'] as String? ?? '',
    online: j['online'] as bool? ?? false,
    capabilities: (j['capabilities'] as List? ?? const []).cast<String>(),
  );
}

/// A project groups sessions from a single agent on a single machine.
class Project {
  final bool saved;
  final String projectId;
  final String name;
  final String cwd;
  final String status;
  final String? activeSessionId;
  final String? summary;
  final ProjectProgress? progress;
  final Approval? pendingApproval;
  final int lastEventAt;
  final int sessionCount;
  final List<Session> sessions; // newest-first; empty when derived client-side
  final String agentId;
  final String agentName;
  final String provider;
  final String nodeId;
  final String nodeName;
  final bool online;
  final List<String> capabilities;

  const Project({
    this.saved = false,
    required this.projectId,
    required this.name,
    required this.cwd,
    required this.status,
    this.activeSessionId,
    this.summary,
    this.progress,
    this.pendingApproval,
    this.lastEventAt = 0,
    this.sessionCount = 0,
    this.sessions = const [],
    this.agentId = 'local-claude',
    this.agentName = 'Claude Code',
    this.provider = 'claude-code',
    this.nodeId = 'local',
    this.nodeName = '本机',
    this.online = true,
    this.capabilities = const [
      'message.send',
      'session.start',
      'session.stop',
      'approval.respond',
    ],
  });

  bool get hasApproval => pendingApproval != null;
  bool supports(String operation) => capabilities.contains(operation);
  bool can(String operation) => online && supports(operation);
  bool canForSession(String? sessionId, String operation) {
    if (!can(operation)) return false;
    final session = sessions.where((s) => s.sessionId == sessionId).firstOrNull;
    return session?.capabilities?.contains(operation) ?? true;
  }

  String get sourceLabel => '$agentName · $nodeName${online ? '' : ' · 离线'}';

  Project withState({
    String? status,
    Approval? approval,
    bool clearApproval = false,
  }) => Project(
    saved: saved,
    projectId: projectId,
    name: name,
    cwd: cwd,
    status: status ?? this.status,
    activeSessionId: approval?.sessionId ?? activeSessionId,
    summary: summary,
    progress: progress,
    pendingApproval: clearApproval ? null : approval ?? pendingApproval,
    lastEventAt: lastEventAt,
    sessionCount: sessionCount,
    sessions: sessions,
    agentId: agentId,
    agentName: agentName,
    provider: provider,
    nodeId: nodeId,
    nodeName: nodeName,
    online: online,
    capabilities: capabilities,
  );

  factory Project.fromJson(Map<String, dynamic> j) => Project(
    saved: j['saved'] == true,
    agentId: j['agentId'] as String? ?? 'local-claude',
    agentName: j['agentName'] as String? ?? 'Claude Code',
    provider: j['provider'] as String? ?? 'claude-code',
    nodeId: j['nodeId'] as String? ?? 'local',
    nodeName: j['nodeName'] as String? ?? '本机',
    online: j['online'] as bool? ?? true,
    capabilities:
        (j['capabilities'] as List?)?.cast<String>() ??
        const [
          'message.send',
          'session.start',
          'session.stop',
          'approval.respond',
        ],
    projectId: j['projectId'] as String? ?? j['project_id'] as String,
    name: j['name'] as String? ?? '',
    cwd: j['cwd'] as String? ?? '',
    status: j['status'] as String? ?? 'running',
    activeSessionId:
        j['activeSessionId'] as String? ?? j['active_session_id'] as String?,
    summary: j['summary'] as String?,
    progress: j['progress'] == null
        ? null
        : ProjectProgress.fromJson(
            (j['progress'] as Map).cast<String, dynamic>(),
          ),
    pendingApproval: j['pendingApproval'] == null
        ? null
        : Approval.fromJson(
            (j['pendingApproval'] as Map).cast<String, dynamic>(),
          ),
    lastEventAt:
        (j['lastEventAt'] as num?)?.toInt() ??
        (j['last_event_at'] as num?)?.toInt() ??
        0,
    sessionCount:
        (j['sessionCount'] as num?)?.toInt() ??
        (j['session_count'] as num?)?.toInt() ??
        0,
    sessions:
        (j['sessions'] as List?)
            ?.map((e) => Session.fromJson((e as Map).cast<String, dynamic>()))
            .toList() ??
        const [],
  );
}

/// An approval request awaiting the user's allow/deny decision.
class Approval {
  final String approvalId;
  final String sessionId;
  final String? projectId;
  final String kind; // command | file_edit
  final String title;
  final String? command;
  final String? filePath;
  final String? diff;
  final String? risk; // danger | normal
  final List<String> options; // once / always / reject
  final int createdAt;
  final int? expiresAt;
  final String status; // pending | approved | denied | expired
  final List<InputQuestion> questions;

  const Approval({
    required this.approvalId,
    required this.sessionId,
    this.projectId,
    required this.kind,
    required this.title,
    this.command,
    this.filePath,
    this.diff,
    this.risk,
    this.options = const ['once', 'always', 'reject'],
    required this.createdAt,
    this.expiresAt,
    this.status = 'pending',
    this.questions = const [],
  });

  bool get isDanger => risk == 'danger';

  /// Expired either by explicit server status or by wall-clock (expiresAt in
  /// the past) — covers cold-start snapshots where the server hasn't swept yet.
  bool get isExpired =>
      status == 'expired' ||
      (expiresAt != null &&
          expiresAt! <= DateTime.now().millisecondsSinceEpoch);

  /// Pending = still actionable: server says pending AND not past expiry.
  bool get isPending => status == 'pending' && !isExpired;

  factory Approval.fromJson(Map<String, dynamic> j) => Approval(
    approvalId: j['approvalId'] as String? ?? j['approval_id'] as String,
    sessionId: j['sessionId'] as String? ?? j['session_id'] as String? ?? '',
    projectId: j['projectId'] as String? ?? j['project_id'] as String?,
    kind: j['kind'] as String? ?? 'command',
    title: j['title'] as String? ?? '需要批准',
    command: j['command'] as String?,
    filePath: j['filePath'] as String? ?? j['file_path'] as String?,
    diff: j['diff'] as String?,
    risk: j['risk'] as String?,
    options:
        (j['options'] as List?)?.map((e) => e.toString()).toList() ??
        const ['once', 'always', 'reject'],
    createdAt:
        (j['createdAt'] as num?)?.toInt() ??
        (j['created_at'] as num?)?.toInt() ??
        0,
    expiresAt:
        (j['expiresAt'] as num?)?.toInt() ?? (j['expires_at'] as num?)?.toInt(),
    status: j['status'] as String? ?? 'pending',
    questions: (j['questions'] as List? ?? const [])
        .map((q) => InputQuestion.fromJson((q as Map).cast<String, dynamic>()))
        .toList(),
  );
}

class InputQuestion {
  final String id;
  final String question;
  final bool isSecret;
  final List<({String label, String description})> options;
  const InputQuestion({
    required this.id,
    required this.question,
    this.isSecret = false,
    this.options = const [],
  });
  factory InputQuestion.fromJson(Map<String, dynamic> j) => InputQuestion(
    id: j['id'] as String,
    question: j['question'] as String,
    isSecret: j['isSecret'] as bool? ?? false,
    options: (j['options'] as List? ?? const [])
        .map(
          (o) => (
            label: o['label'] as String,
            description: o['description'] as String? ?? '',
          ),
        )
        .toList(),
  );
}
