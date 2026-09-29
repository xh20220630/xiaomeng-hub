import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import '../services/host_resources.dart';
import '../widgets/host_resource_scope.dart';
import '../widgets/markdown_text.dart';
import '../widgets/copy_action.dart';
import '../theme/tokens.dart';

class ResourcePreviewScreen extends ConsumerStatefulWidget {
  final String sessionId, reference;
  final String? baseResourceId;
  const ResourcePreviewScreen({
    super.key,
    required this.sessionId,
    required this.reference,
    this.baseResourceId,
  });
  @override
  ConsumerState<ResourcePreviewScreen> createState() =>
      _ResourcePreviewScreenState();
}

class _ResourcePreviewScreenState extends ConsumerState<ResourcePreviewScreen> {
  HostResource? _resource;
  HostResourceService? _service;
  http.Client? _client;
  Uint8List? _image;
  String? _error;
  bool _loading = true, _source = false, _truncated = false;
  String _search = '', _encoding = '';
  final _lines = <({int number, String text})>[];
  final _entries = <Map<String, dynamic>>[];
  int? _nextLine;
  String? _cursor;
  int _generation = 0;
  @override
  void dispose() {
    _generation++;
    _client?.close();
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    final generation = ++_generation;
    _client?.close();
    final client = _client = http.Client();
    setState(() {
      _loading = true;
      _error = null;
      if (!more) {
        _resource = null;
        _image = null;
        _lines.clear();
        _entries.clear();
        _nextLine = null;
        _cursor = null;
      }
    });
    try {
      final service = ref.read(hostResourcesProvider);
      final resource =
          _resource ??
          await service.resolve(
            widget.sessionId,
            widget.reference,
            baseResourceId: widget.baseResourceId,
            client: client,
          );
      if (!mounted || generation != _generation) return;
      _resource = resource;
      if (resource.kind == 'image') {
        final bytes = await service.image(
          resource,
          thumbnail: false,
          client: client,
        );
        if (!mounted || generation != _generation) return;
        _image = bytes;
      } else if (['text', 'markdown'].contains(resource.kind)) {
        final data = await service.text(
          resource,
          startLine: more
              ? _nextLine!
              : ((resource.line ?? 1) - 8).clamp(1, 1000000),
          client: client,
        );
        if (!mounted || generation != _generation) return;
        final start = (data['startLine'] as num).toInt();
        final text = (data['text'] as String).split('\n');
        _lines.addAll([
          for (var i = 0; i < text.length; i++)
            (number: start + i, text: text[i]),
        ]);
        _nextLine = (data['nextLine'] as num?)?.toInt();
        _truncated = data['truncated'] == true;
        _encoding = data['encoding'] as String? ?? '';
        if (_lines.length >= 2000) {
          _nextLine = null;
          _truncated = true;
        }
      } else if (resource.kind == 'directory') {
        final data = await service.list(
          resource,
          cursor: more ? _cursor : null,
          client: client,
        );
        if (!mounted || generation != _generation) return;
        _entries.addAll((data['entries'] as List).cast<Map<String, dynamic>>());
        _cursor = data['nextCursor'] as String?;
      }
    } catch (error) {
      if (mounted && generation == _generation) _error = '$error';
    } finally {
      client.close();
      if (mounted && generation == _generation) {
        setState(() => _loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final service = ref.watch(hostResourcesProvider);
    if (_service != service) {
      _service = service;
      _generation++;
      _client?.close();
      _resource = null;
      _image = null;
      _lines.clear();
      _entries.clear();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _load();
      });
    }
    final resource = _resource;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          resource?.name ?? '文件预览',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        actions: [
          CopyAction(text: widget.reference, label: '复制路径'),
          IconButton(
            onPressed: _loading ? null : () => _load(),
            tooltip: '刷新预览',
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: Column(
        children: [
          if (resource != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
              child: Row(
                children: [
                  const Icon(Icons.computer_rounded, size: 16),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${resource.sourceName} · ${resource.sizeLabel} · ${resource.snapshot ? '消息附件' : '当前文件内容'}',
                      style: AppFont.ui(size: 12),
                    ),
                  ),
                ],
              ),
            ),
          if (resource != null &&
              ['text', 'markdown'].contains(resource.kind)) ...[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Column(
                children: [
                  Row(
                    children: [
                      if (resource.kind == 'markdown')
                        TextButton.icon(
                          onPressed: () => setState(() => _source = !_source),
                          icon: Icon(
                            _source ? Icons.visibility_outlined : Icons.code,
                          ),
                          label: Text(_source ? '预览' : '源码'),
                        ),
                      const Spacer(),
                      CopyAction(
                        text: _lines.map((l) => l.text).join('\n'),
                        label: '复制内容',
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  TextField(
                    onChanged: (value) => setState(() => _search = value),
                    decoration: const InputDecoration(
                      isDense: true,
                      hintText: '搜索已加载内容',
                      prefixIcon: Icon(Icons.search_rounded),
                    ),
                  ),
                ],
              ),
            ),
            if (_truncated)
              const Padding(
                padding: EdgeInsets.all(10),
                child: Text('文件较大，当前仅展示有限预览', style: TextStyle(fontSize: 12)),
              ),
          ],
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                children: [
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: _loading ? null : () => _load(),
                    child: const Text('重新加载'),
                  ),
                ],
              ),
            ),
          Expanded(
            child: resource == null ? const SizedBox() : _content(resource),
          ),
        ],
      ),
    );
  }

  Widget _content(HostResource resource) {
    if (resource.kind == 'image') {
      return _image == null
          ? const SizedBox()
          : Container(
              color: const Color(0xff12161b),
              child: Center(
                child: InteractiveViewer(
                  minScale: .5,
                  maxScale: 8,
                  child: Image.memory(
                    _image!,
                    fit: BoxFit.contain,
                    errorBuilder: (_, _, _) => const Text(
                      '图片无法解码',
                      style: TextStyle(color: Colors.white),
                    ),
                  ),
                ),
              ),
            );
    }
    if (resource.kind == 'directory') {
      return ListView(
        children: [
          for (final entry in _entries)
            ListTile(
              leading: Icon(
                entry['directory'] == true
                    ? Icons.folder_outlined
                    : Icons.insert_drive_file_outlined,
              ),
              title: Text(entry['name'] as String),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => ResourcePreviewScreen(
                    sessionId: widget.sessionId,
                    reference: entry['reference'] as String,
                    baseResourceId: resource.id,
                  ),
                ),
              ),
            ),
          if (_cursor != null)
            TextButton(
              onPressed: _loading ? null : () => _load(more: true),
              child: const Text('加载更多文件'),
            ),
          if (_entries.isEmpty && !_loading && _error == null)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('此目录为空', textAlign: TextAlign.center),
            ),
        ],
      );
    }
    if (!['text', 'markdown'].contains(resource.kind)) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('暂不支持此文件类型的预览', textAlign: TextAlign.center),
        ),
      );
    }
    final lines = _search.isEmpty
        ? _lines
        : _lines
              .where(
                (line) =>
                    line.text.toLowerCase().contains(_search.toLowerCase()),
              )
              .toList();
    return HostResourceScope(
      sessionId: widget.sessionId,
      baseResourceId: resource.id,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (resource.kind == 'markdown' && !_source && _search.isEmpty)
            SelectionArea(
              child: MarkdownText(
                _lines.map((line) => line.text).join('\n'),
                size: 14,
              ),
            )
          else
            for (final line in lines)
              Container(
                color: line.number == resource.line ? AppColors.halo : null,
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 48,
                      child: Text(
                        '${line.number}',
                        style: AppFont.mono(
                          size: 11,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ),
                    Expanded(
                      child: SelectableText(
                        line.text,
                        style: AppFont.mono(size: 12),
                      ),
                    ),
                  ],
                ),
              ),
          if (_search.isNotEmpty && lines.isEmpty) const Text('已加载内容中没有匹配结果'),
          if (_nextLine != null)
            TextButton(
              onPressed: _loading ? null : () => _load(more: true),
              child: const Text('继续读取'),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 14),
            child: Text(
              '只读预览 · $_encoding',
              style: AppFont.ui(size: 11, color: AppColors.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}
