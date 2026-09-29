import type { AgentHandlers } from '../types/sdk.js';
import type { ResourceContext } from '../types/resources.js';
import { HostResources, resourceError, ResourceError } from './host-resources.js';

export function resourceHandlers(
  store: HostResources,
  context: (sessionId: string) => ResourceContext,
  upload: (id: string, bytes: Buffer, mimeType: string) => Promise<unknown>,
): AgentHandlers {
  const handle = async <T>(action: () => Promise<T>) => {
    try {
      return await action();
    } catch (error) {
      const known = resourceError(error);
      throw new Error(`[${known.code}] ${known.message}`);
    }
  };
  return {
    'resources.resolve': (p) =>
      handle(() =>
        store.resolve(context(p.sessionId), p.resource.reference!, p.resource.baseResourceId),
      ),
    'resources.list': (p) =>
      handle(() => store.list(context(p.sessionId), p.resource.resourceId!, p.resource.cursor)),
    'resources.read': (p) =>
      handle(async () => {
        const r = p.resource;
        if (
          !r.transferId ||
          !r.resourceId ||
          !r.version ||
          !['text', 'content', 'thumbnail'].includes(r.variant || '')
        )
          throw new ResourceError('INVALID_REFERENCE', '资源请求无效');
        if (r.variant === 'text') {
          const data = await store.text(context(p.sessionId), r.resourceId, r.version, r.startLine);
          return upload(r.transferId, Buffer.from(JSON.stringify(data)), 'application/json');
        }
        const image = await store.image(
          context(p.sessionId),
          r.resourceId,
          r.version,
          r.variant === 'thumbnail',
        );
        return upload(r.transferId, image.bytes, image.mimeType);
      }),
  };
}
