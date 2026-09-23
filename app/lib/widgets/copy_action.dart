import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/tokens.dart';

class CopyAction extends StatefulWidget {
  final String text;
  final String label;
  final Color color;
  const CopyAction({
    super.key,
    required this.text,
    required this.label,
    this.color = AppColors.textSecondary,
  });
  @override
  State<CopyAction> createState() => _CopyActionState();
}

class _CopyActionState extends State<CopyAction> {
  bool _copied = false;
  @override
  void didUpdateWidget(CopyAction oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) _copied = false;
  }

  @override
  Widget build(BuildContext context) => TextButton.icon(
    style: TextButton.styleFrom(
      foregroundColor: widget.color,
      minimumSize: const Size(44, 44),
      textStyle: AppFont.ui(size: 11),
    ),
    onPressed: () async {
      try {
        await Clipboard.setData(ClipboardData(text: widget.text));
        if (mounted) setState(() => _copied = true);
      } catch (_) {
        if (context.mounted) {
          ScaffoldMessenger.maybeOf(
            context,
          )?.showSnackBar(const SnackBar(content: Text('复制失败，请选择文字后复制')));
        }
      }
    },
    icon: Icon(_copied ? Icons.check_rounded : Icons.copy_outlined, size: 14),
    label: Text(_copied ? '已复制' : widget.label),
  );
}
