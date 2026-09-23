import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models.dart';

class HistoryPage {
  final List<TaskEvent> events;
  final String? nextCursor;
  const HistoryPage(this.events, this.nextCursor);
}

/// REST client for initial load, re-sync after a WS reconnect, and the
/// approval-respond / message-send fallbacks when the WebSocket is down.
/// All requests carry `Authorization: Bearer <token>` when a token is set
/// (server ignores it when AUTH_TOKEN is unset — back-compat).
class ApiService {
  final String baseUrl;
  final String token;
  ApiService(this.baseUrl, {this.token = ''});

  Map<String, String> get _authHeaders =>
      token.isEmpty ? const {} : {'Authorization': 'Bearer $token'};

  Map<String, String> get _jsonHeaders => {
    'Content-Type': 'application/json',
    ..._authHeaders,
  };

  Future<List<Session>> getSessions() async {
    final r = await http
        .get(Uri.parse('$baseUrl/api/sessions'), headers: _authHeaders)
        .timeout(const Duration(seconds: 5));
    final list = jsonDecode(r.body) as List;
    return list
        .map((e) => Session.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<List<TaskEvent>> getEvents(String sessionId, {int limit = 200}) async {
    final r = await http
        .get(
          Uri.parse('$baseUrl/api/sessions/$sessionId/events?limit=$limit'),
          headers: _authHeaders,
        )
        .timeout(const Duration(seconds: 5));
    final list = jsonDecode(r.body) as List;
    return list
        .map((e) => TaskEvent.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<HistoryPage> getHistory(String sessionId, {String? cursor}) async {
    final uri = Uri.parse(
      '$baseUrl/api/sessions/$sessionId/history',
    ).replace(queryParameters: {'limit': '40', 'cursor': ?cursor});
    final response = await http
        .get(uri, headers: _authHeaders)
        .timeout(const Duration(seconds: 35));
    if (response.statusCode != 200) {
      throw StateError('暂时无法读取会话（${response.statusCode}），请重试');
    }
    final data = jsonDecode(response.body) as Map<String, dynamic>;
    return HistoryPage(
      (data['events'] as List)
          .map((e) => TaskEvent.fromJson(e as Map<String, dynamic>))
          .toList(),
      data['nextCursor'] as String?,
    );
  }

  Future<List<Project>> getProjects() async {
    final r = await http
        .get(Uri.parse('$baseUrl/api/projects'), headers: _authHeaders)
        .timeout(const Duration(seconds: 5));
    final list = jsonDecode(r.body) as List;
    return list
        .map((e) => Project.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<List<AgentInfo>> getAgents() async {
    final r = await http
        .get(Uri.parse('$baseUrl/api/agents'), headers: _authHeaders)
        .timeout(const Duration(seconds: 5));
    if (r.statusCode != 200) throw StateError('无法获取 Agent 列表');
    return (jsonDecode(r.body) as List)
        .map((e) => AgentInfo.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<List<Approval>> getApprovals() async {
    final r = await http
        .get(Uri.parse('$baseUrl/api/approvals'), headers: _authHeaders)
        .timeout(const Duration(seconds: 5));
    final list = jsonDecode(r.body) as List;
    return list
        .map((e) => Approval.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// REST fallback for approval.respond when the WebSocket is unavailable.
  Future<bool> resolveApproval(
    String approvalId, {
    required String decision,
    String scope = 'once',
    Map<String, String>? answers,
  }) async {
    try {
      final r = await http
          .post(
            Uri.parse('$baseUrl/api/approvals/$approvalId'),
            headers: _jsonHeaders,
            body: jsonEncode({
              'decision': decision,
              'scope': scope,
              'answers': answers,
            }),
          )
          .timeout(const Duration(seconds: 5));
      if (r.statusCode < 200 || r.statusCode >= 300) return false;
      final result = jsonDecode(r.body) as Map;
      return result['status'] != 'failed' && result['status'] != 'expired';
    } catch (_) {
      return false;
    }
  }

  /// POST /api/sessions/:id/message — REST path for sending a reply into an
  /// existing session (contract addition; WS message.send remains primary).
  Future<bool> sendSessionMessage(String sessionId, String text) async {
    try {
      final r = await http
          .post(
            Uri.parse('$baseUrl/api/sessions/$sessionId/message'),
            headers: _jsonHeaders,
            body: jsonEncode({'text': text}),
          )
          .timeout(const Duration(seconds: 8));
      return r.statusCode >= 200 && r.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  /// POST /api/projects/:id/sessions — start a brand-new session in a project
  /// with the first prompt. Returns the new sessionId, or null on failure.
  Future<String?> createSession(String projectId, String text) async {
    try {
      final r = await http
          .post(
            Uri.parse('$baseUrl/api/projects/$projectId/sessions'),
            headers: _jsonHeaders,
            body: jsonEncode({'text': text}),
          )
          .timeout(const Duration(seconds: 65));
      if (r.statusCode < 200 || r.statusCode >= 300) return null;
      final j = jsonDecode(r.body);
      if (j is Map && j['sessionId'] is String) return j['sessionId'] as String;
      return null;
    } catch (_) {
      return null;
    }
  }

  Future<bool> ping() async {
    try {
      final r = await http
          .get(Uri.parse('$baseUrl/health'), headers: _authHeaders)
          .timeout(const Duration(seconds: 3));
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  Future<Map<String, dynamic>> agentCatalog(
    String agentId,
    String sessionId,
  ) => _operation(
    '/agents/${Uri.encodeComponent(agentId)}/catalog?sessionId=${Uri.encodeComponent(sessionId)}',
  );

  Future<Map<String, dynamic>> configureSession(
    String sessionId,
    Map<String, String> settings,
  ) => _operation('/sessions/${Uri.encodeComponent(sessionId)}/configure', {
    'settings': settings,
  });

  Future<Map<String, dynamic>> compactSession(String sessionId) =>
      _operation('/sessions/${Uri.encodeComponent(sessionId)}/compact', {});

  Future<Map<String, dynamic>> agentAction(
    String agentId,
    String sessionId,
    String name,
  ) => _operation('/agents/${Uri.encodeComponent(agentId)}/actions', {
    'sessionId': sessionId,
    'name': name,
    'arguments': {},
  });

  Future<Map<String, dynamic>> _operation(
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    final uri = Uri.parse('$baseUrl/api$path');
    final response =
        await (body == null
                ? http.get(uri, headers: _authHeaders)
                : http.post(uri, headers: _jsonHeaders, body: jsonEncode(body)))
            .timeout(const Duration(seconds: 35));
    final data = jsonDecode(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError(data is Map ? '${data['error'] ?? '主机操作失败'}' : '主机操作失败');
    }
    return data is Map<String, dynamic> ? data : {'data': data};
  }
}
