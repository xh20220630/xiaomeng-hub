import 'dart:convert';
import 'package:flutter/material.dart';
import 'studio_icon.dart';
import '../models.dart';
import '../services/api_service.dart';
import '../theme/tokens.dart';

class AgentSettingsSheet extends StatefulWidget {
  final ApiService api;
  final Project project;
  final Session session;
  final String? selectedModel;
  final ValueChanged<Map<String, String>>? onConfigured;
  const AgentSettingsSheet({
    super.key,
    required this.api,
    required this.project,
    required this.session,
    this.selectedModel,
    this.onConfigured,
  });

  @override
  State<AgentSettingsSheet> createState() => _AgentSettingsSheetState();
}

class _AgentSettingsSheetState extends State<AgentSettingsSheet> {
  Map<String, dynamic>? _catalog;
  String? _model, _effort, _mode, _error, _notice;
  bool _busy = false;

  List<Map<String, dynamic>> _items(String name) =>
      (_catalog?[name] as List? ?? [])
          .whereType<Map>()
          .map((m) => Map<String, dynamic>.from(m))
          .toList();

  List<String> get _efforts =>
      (_items('models')
                      .where((m) => m['id'] == _model)
                      .firstOrNull?['reasoningEfforts']
                  as List? ??
              [])
          .cast<String>();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final catalog = await widget.api.agentCatalog(
        widget.project.agentId,
        widget.session.sessionId,
      );
      if (!mounted) return;
      setState(() {
        _catalog = catalog;
        final currentModel = widget.selectedModel ?? widget.session.model;
        _model = _items('models').any((m) => m['id'] == currentModel)
            ? currentModel
            : null;
        _effort = _efforts.contains(widget.session.reasoningEffort)
            ? widget.session.reasoningEffort
            : null;
        _mode = _items('modes').any((m) => m['id'] == widget.session.mode)
            ? widget.session.mode
            : null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final settings = <String, String>{
      'model': ?_model,
      'reasoningEffort': ?_effort,
      'mode': ?_mode,
    };
    if (settings.isEmpty) return;
    await _run(() async {
      await widget.api.configureSession(widget.session.sessionId, settings);
      widget.onConfigured?.call(settings);
      if (mounted) setState(() => _notice = '主机已确认，设置将在下一轮对话生效');
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _action(Map<String, dynamic> action) => _run(() async {
    final result = await widget.api.agentAction(
      widget.project.agentId,
      widget.session.sessionId,
      action['id'] as String,
    );
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('${action['name']}'),
        backgroundColor: Colors.white,
        content: SizedBox(
          width: 560,
          child: SingleChildScrollView(
            child: result['entries'] is List
                ? Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if ((result['entries'] as List).isEmpty)
                        const Text('主机暂未提供可用项目'),
                      for (final entry in result['entries'] as List)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 18),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '${entry['name']}',
                                style: const TextStyle(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              if (entry['description'] != null)
                                Text(
                                  '${entry['description']}',
                                  style: const TextStyle(fontSize: 13),
                                ),
                              if (entry['detail'] != null)
                                SelectableText(
                                  '${entry['detail']}',
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: Colors.black54,
                                  ),
                                ),
                              if (entry['status'] != null)
                                Text(
                                  _statusLabel('${entry['status']}'),
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: Colors.black54,
                                  ),
                                ),
                            ],
                          ),
                        ),
                      for (final warning in result['warnings'] as List? ?? [])
                        Text(
                          '$warning',
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                    ],
                  )
                : SelectableText(
                    const JsonEncoder.withIndent('  ').convert(result),
                  ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  });

  String _statusLabel(String value) =>
      const {
        'enabled': '已启用',
        'disabled': '已停用',
        'available': '可用',
        'ready': '已就绪',
        'starting': '连接中',
        'failed': '连接失败',
        'oauth': '已连接账户',
        'bearerToken': '令牌认证',
        'unsupported': '无需账户认证',
      }[value] ??
      value;

  @override
  Widget build(BuildContext context) {
    final canConfigure = widget.project.canForSession(
      widget.session.sessionId,
      'session.configure',
    );
    final canCompact =
        widget.project.canForSession(
          widget.session.sessionId,
          'session.compact',
        ) &&
        widget.session.status != 'running';
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * .9,
          maxWidth: 640,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  const StudioIcon(StudioSymbol.settings, size: 38),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Text(
                      '对话设置',
                      style: TextStyle(
                        fontSize: 21,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              Text(
                '${widget.project.agentName} · ${widget.project.nodeName}',
                style: AppFont.ui(size: 12, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: AppColors.halo,
                  borderRadius: BorderRadius.circular(AppRadii.card),
                ),
                child: Text(
                  '为这次创作，找到合适的节奏。',
                  style: AppFont.ui(size: 13, color: AppColors.primaryDeep),
                ),
              ),
              const SizedBox(height: 12),
              if (_catalog?['controlTransport'] == 'desktop-ipc')
                const ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.desktop_windows_outlined),
                  title: Text('已连接桌面会话'),
                  subtitle: Text('追加指令、停止和审批会直接交给宿主机'),
                ),
              if (_busy) const LinearProgressIndicator(),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Text(
                    _error!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              if (_catalog == null && !_busy)
                TextButton(onPressed: _load, child: const Text('重新连接主机')),
              if (_catalog != null) ...[
                if (!canConfigure)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(widget.session.controlReason ?? '此任务暂不支持修改设置'),
                  ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  key: ValueKey('model:$_model'),
                  initialValue: _model,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: '模型'),
                  hint: Text(
                    widget.selectedModel ?? widget.session.model ?? '选择宿主机模型',
                  ),
                  items: _items('models')
                      .map(
                        (m) => DropdownMenuItem(
                          value: m['id'] as String,
                          child: Text(
                            '${m['name'] ?? m['id']}',
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: !canConfigure || _busy
                      ? null
                      : (value) => setState(() {
                          _model = value;
                          _effort = null;
                          _notice = null;
                        }),
                ),
                if (_efforts.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    key: ValueKey('effort:$_model:$_effort'),
                    initialValue: _effort,
                    decoration: const InputDecoration(labelText: '推理强度'),
                    hint: const Text('保持当前设置'),
                    items: _efforts
                        .map((e) => DropdownMenuItem(value: e, child: Text(e)))
                        .toList(),
                    onChanged: !canConfigure || _busy
                        ? null
                        : (value) => setState(() => _effort = value),
                  ),
                ],
                if (_items('modes').isNotEmpty) ...[
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    key: ValueKey('mode:$_mode'),
                    initialValue: _mode,
                    decoration: const InputDecoration(labelText: '工作模式'),
                    hint: const Text('保持当前模式'),
                    items: _items('modes')
                        .map(
                          (m) => DropdownMenuItem(
                            value: m['id'] as String,
                            child: Text('${m['name']}'),
                          ),
                        )
                        .toList(),
                    onChanged: !canConfigure || _busy
                        ? null
                        : (value) => setState(() => _mode = value),
                  ),
                ],
                const SizedBox(height: 12),
                const Text(
                  '设置在下一轮对话生效，当前执行会继续使用原设置。',
                  style: TextStyle(fontSize: 12, color: Colors.black54),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed:
                      !canConfigure ||
                          _busy ||
                          (_model == null && _effort == null && _mode == null)
                      ? null
                      : _save,
                  child: const Text('应用到此会话'),
                ),
                if (_notice != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      _notice!,
                      style: const TextStyle(color: Color(0xff18775c)),
                    ),
                  ),
                if (_items('actions').isNotEmpty || canCompact) ...[
                  const Divider(height: 32),
                  const Text(
                    '在宿主机上',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 8),
                    child: Text(
                      '在对话中描述要使用的工具或技能，执行与权限确认都发生在宿主机。',
                      style: TextStyle(fontSize: 12, color: Colors.black54),
                    ),
                  ),
                  for (final action in _items('actions'))
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text('${action['name']}'),
                      subtitle: Text('${action['description'] ?? ''}'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: _busy ? null : () => _action(action),
                    ),
                  if (canCompact)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('压缩上下文'),
                      subtitle: const Text('保留会话，整理已使用的上下文'),
                      trailing: const Icon(Icons.compress),
                      onTap: _busy
                          ? null
                          : () => _run(() async {
                              await widget.api.compactSession(
                                widget.session.sessionId,
                              );
                              if (mounted) {
                                setState(() => _notice = '主机已接收压缩请求');
                              }
                            }),
                    ),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }
}
