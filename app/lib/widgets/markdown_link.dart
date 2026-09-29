import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'copy_action.dart';
import 'host_resource_scope.dart';
import '../screens/resource_preview_screen.dart';

Future<void> openMarkdownLink(BuildContext context, String destination) async {
  var address = destination.trim();
  if (address.startsWith('<') && address.endsWith('>')) {
    address = address.substring(1, address.length - 1).trim();
  }
  if (address.startsWith('//')) address = 'https:$address';
  final uri = Uri.tryParse(address);
  final fileUri = Uri.tryParse(
    address.replaceFirst(RegExp(r'(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$'), ''),
  );
  final isFile =
      RegExp(r'^[a-zA-Z]:[/\\]').hasMatch(address) ||
      address.startsWith(r'\\') ||
      uri?.scheme == 'file' ||
      uri?.scheme == 'attachment' ||
      (fileUri != null &&
          !fileUri.hasScheme &&
          (fileUri.path.isNotEmpty || RegExp(r'^#L\d+').hasMatch(address)));

  String message;
  if (isFile) {
    final scope = HostResourceScope.maybeOf(context);
    if (scope != null) {
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ResourcePreviewScreen(
            sessionId: scope.sessionId,
            reference: address,
            baseResourceId: scope.baseResourceId,
          ),
        ),
      );
      return;
    }
    // Agent paths belong to the host workspace, not the phone's filesystem.
    message = '这是电脑上的文件路径，手机目前无法直接打开。可复制路径后在电脑上查看。';
  } else if (uri == null || address.isEmpty) {
    message = '链接地址不完整或格式不正确，可复制地址后检查。';
  } else if ((uri.scheme == 'http' || uri.scheme == 'https') &&
      uri.host.isEmpty) {
    message = '网页链接缺少有效地址，可复制地址后检查。';
  } else if (const {
    'http',
    'https',
    'mailto',
    'tel',
    'sms',
  }.contains(uri.scheme)) {
    try {
      if (await launchUrl(uri, mode: LaunchMode.externalApplication)) return;
    } catch (_) {
      // Platform failures still need a visible response to the tap.
    }
    message = '未能打开链接，请检查是否安装了可处理此链接的应用，或复制地址后打开。';
  } else {
    message = '当前无法直接打开此类链接，可复制地址后在对应应用中查看。';
  }

  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(isFile ? '电脑文件' : '无法打开链接'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(message),
            if (address.isNotEmpty) ...[
              const SizedBox(height: 16),
              SelectableText(address),
            ],
          ],
        ),
      ),
      actions: [
        if (address.isNotEmpty)
          CopyAction(text: address, label: isFile ? '复制路径' : '复制链接'),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('关闭'),
        ),
      ],
    ),
  );
}
