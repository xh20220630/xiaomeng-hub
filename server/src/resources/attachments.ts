import type { ResourceAttachment, ResourceContext } from '../types/resources.js';
import { HostResources } from './host-resources.js';
import { ResourceError } from './host-resources.js';

export async function collectAttachments(
  store: HostResources,
  context: ResourceContext,
  value: unknown,
): Promise<ResourceAttachment[]> {
  const result: ResourceAttachment[] = [];
  const blocks: unknown[] = Array.isArray(value)
    ? [...value]
    : value && typeof value === 'object' && 'content' in value && Array.isArray(value.content)
      ? [...value.content]
      : [value];
  let visited = 0;
  while (blocks.length && result.length < 12 && visited++ < 64) {
    const item = blocks.shift();
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      blocks.push(...block.content.slice(0, 12));
      continue;
    }
    if (!['image', 'input_image', 'localImage', 'resource_link'].includes(String(block.type)))
      continue;
    const source =
      block.source && typeof block.source === 'object'
        ? (block.source as Record<string, unknown>)
        : {};
    const url =
      typeof block.url === 'string'
        ? block.url
        : typeof block.image_url === 'string'
          ? block.image_url
          : typeof source.url === 'string'
            ? source.url
            : '';
    let data =
      typeof block.data === 'string'
        ? block.data
        : typeof source.data === 'string'
          ? source.data
          : '';
    let mime = String(block.mimeType || block.mime_type || source.media_type || '');
    const inline = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (inline) {
      mime = inline[1];
      data = inline[2];
    }
    try {
      if (data) {
        result.push(await store.snapshot(context, data, mime));
      } else {
        const reference =
          typeof block.path === 'string'
            ? block.path
            : typeof block.uri === 'string'
              ? block.uri
              : url;
        if (!reference || reference.length > 4096) continue;
        const name = String(block.title || block.name || '图片附件').slice(0, 200);
        if (/^https?:\/\//.test(reference)) {
          result.push({ reference, name, kind: block.type === 'resource_link' ? 'file' : 'image' });
        } else {
          const metadata = await store.resolve(context, reference);
          result.push({
            reference,
            name: metadata.name,
            kind: metadata.kind === 'image' ? 'image' : 'file',
          });
        }
      }
    } catch {
      /* Unavailable attachments must not hide the surrounding conversation. */
    }
  }
  return [...new Map(result.map((item) => [item.reference, item])).values()];
}

export function validateAttachments(value: unknown): ResourceAttachment[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 12)
    throw new ResourceError('INVALID_ATTACHMENT', 'Invalid attachments');
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry.reference !== 'string' ||
      entry.reference.length > 4096 ||
      typeof entry.name !== 'string' ||
      entry.name.length > 1024 ||
      !['image', 'file'].includes(entry.kind)
    )
      throw new ResourceError('INVALID_ATTACHMENT', 'Invalid attachment');
    return {
      reference: entry.reference,
      name: entry.name,
      kind: entry.kind,
      snapshot: entry.snapshot === true,
    };
  });
}
