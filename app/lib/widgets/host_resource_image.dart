import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import '../services/host_resources.dart';
import '../screens/resource_preview_screen.dart';
import 'host_resource_scope.dart';

class HostResourceImage extends ConsumerStatefulWidget {
  final String reference;
  const HostResourceImage(this.reference, {super.key});
  @override
  ConsumerState<HostResourceImage> createState() => _HostResourceImageState();
}

class _HostResourceImageState extends ConsumerState<HostResourceImage> {
  http.Client? _client;
  Future<Uint8List>? _loading;
  HostResourceService? _service;
  String? _key;
  @override
  void dispose() {
    _client?.close();
    super.dispose();
  }

  Future<Uint8List> _load(
    HostResourceService service,
    HostResourceScope scope,
  ) async {
    final client = _client = http.Client();
    try {
      final resource = await service.resolve(
        scope.sessionId,
        widget.reference,
        baseResourceId: scope.baseResourceId,
        client: client,
      );
      return await service.image(resource, client: client);
    } finally {
      client.close();
    }
  }

  @override
  Widget build(BuildContext context) {
    final scope = HostResourceScope.maybeOf(context);
    final uri = Uri.tryParse(widget.reference);
    final remote =
        uri != null &&
        ['https', 'http'].contains(uri.scheme) &&
        uri.host.isNotEmpty;
    if (remote) {
      return ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 280),
        child: Image.network(
          widget.reference,
          cacheWidth: 1024,
          fit: BoxFit.contain,
          errorBuilder: (_, _, _) => const Text('图片暂时无法加载'),
        ),
      );
    }
    if (scope == null) return const Text('图片需要在所属会话中打开');
    final service = ref.watch(hostResourcesProvider);
    final key =
        '${scope.sessionId}:${scope.baseResourceId}:${widget.reference}';
    if (_key != key || _service != service || _loading == null) {
      _client?.close();
      _key = key;
      _service = service;
      _loading = _load(service, scope);
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => ResourcePreviewScreen(
              sessionId: scope.sessionId,
              reference: widget.reference,
              baseResourceId: scope.baseResourceId,
            ),
          ),
        ),
        borderRadius: BorderRadius.circular(16),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: FutureBuilder<Uint8List>(
            key: ValueKey('$_key:${identityHashCode(service)}'),
            future: _loading,
            builder: (context, snapshot) {
              if (snapshot.hasData) {
                return Image.memory(
                  snapshot.data!,
                  height: 220,
                  width: double.infinity,
                  fit: BoxFit.contain,
                  cacheWidth: 1024,
                  errorBuilder: (_, _, _) => const _ImageHint('图片无法解码，点击查看详情'),
                );
              }
              if (snapshot.hasError) {
                return _ImageHint('${snapshot.error}\n点击重试或查看详情');
              }
              return const SizedBox(
                height: 160,
                child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
              );
            },
          ),
        ),
      ),
    );
  }
}

class _ImageHint extends StatelessWidget {
  final String text;
  const _ImageHint(this.text);
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(18),
    color: Theme.of(context).colorScheme.surfaceContainerHighest,
    child: Row(
      children: [
        const Icon(Icons.image_outlined),
        const SizedBox(width: 10),
        Expanded(child: Text(text, style: const TextStyle(fontSize: 12))),
      ],
    ),
  );
}
