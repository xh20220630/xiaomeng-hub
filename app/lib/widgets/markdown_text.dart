import 'package:flutter/material.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import '../theme/tokens.dart';
import 'copy_action.dart';

/// Accepts incomplete Markdown while a response is streaming.
class MarkdownText extends StatelessWidget {
  final String text;
  final Color color;
  final double size;

  const MarkdownText(
    this.text, {
    super.key,
    this.color = AppColors.bodySecondary,
    this.size = 16,
  });

  @override
  Widget build(BuildContext context) {
    return GptMarkdown(
      text,
      style: AppFont.ui(
        size: size,
        weight: FontWeight.w400,
        color: color,
        height: 1.75,
      ),
      codeBuilder: (context, name, code, closed) =>
          _CodeBlock(name: name, code: code, closed: closed),
      highlightBuilder: (context, inline, style) => _InlineCode(inline),
    );
  }
}

class _CodeBlock extends StatelessWidget {
  final String name;
  final String code;
  final bool closed;
  const _CodeBlock({
    required this.name,
    required this.code,
    required this.closed,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.codeBg,
        borderRadius: BorderRadius.circular(AppRadii.tool),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 14, right: 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    name.trim().isEmpty ? '代码' : name.trim(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppFont.mono(size: 11, color: AppColors.codeTitle),
                  ),
                ),
                if (!closed)
                  const Padding(
                    padding: EdgeInsets.only(right: 8),
                    child: Text(
                      '生成中',
                      style: TextStyle(
                        fontSize: 10,
                        color: AppColors.codeTitle,
                      ),
                    ),
                  ),
                CopyAction(
                  text: code,
                  label: '复制代码',
                  color: AppColors.codeTitle,
                ),
              ],
            ),
          ),
          const Divider(height: 1, color: Color(0xFF373A41)),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.all(14),
            child: SelectionArea(
              child: Text(
                code.trimRight(),
                style: AppFont.mono(
                  size: 13,
                  weight: FontWeight.w400,
                  color: AppColors.codeHighlight,
                  height: 1.6,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Inline `code` — subtle warm chip.
class _InlineCode extends StatelessWidget {
  final String text;
  const _InlineCode(this.text);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
      decoration: BoxDecoration(
        color: AppColors.halo.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        text,
        style: AppFont.mono(
          size: 12,
          weight: FontWeight.w500,
          color: AppColors.primaryDeep,
        ),
      ),
    );
  }
}
