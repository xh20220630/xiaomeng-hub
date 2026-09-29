import 'package:flutter/material.dart';
import '../models.dart';
import 'host_resource_image.dart';
import 'markdown_link.dart';

class ResourceAttachments extends StatelessWidget {
  final List<ResourceAttachment> attachments;
  const ResourceAttachments(this.attachments, {super.key});
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final attachment in attachments)
        attachment.kind == 'image'
            ? HostResourceImage(attachment.reference)
            : TextButton.icon(
                onPressed: () =>
                    openMarkdownLink(context, attachment.reference),
                icon: const Icon(Icons.insert_drive_file_outlined),
                label: Text(attachment.name),
              ),
    ],
  );
}
