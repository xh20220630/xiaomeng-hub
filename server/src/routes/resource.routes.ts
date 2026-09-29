import { Router } from 'express';
import type { Request, Response } from 'express';
import * as resources from '../services/resource.service.js';
import { ResourceError } from '../resources/host-resources.js';

export function createResourceRouter(
  authConfigured: boolean,
  authorize: (token: string) => boolean,
) {
  const router = Router();
  let active = 0;
  const run =
    (handler: (req: Request, owner: string, signal: AbortSignal) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (!authConfigured)
        return res.status(503).json({ code: 'AUTH_REQUIRED', error: '请先在宿主机配置配对认证' });
      if (!req.headers.authorization?.startsWith('Bearer ') || !token || !authorize(token))
        return res.status(401).json({ code: 'UNAUTHORIZED', error: '配对已失效，请重新连接主机' });
      if (active >= 16)
        return res.status(429).json({ code: 'BUSY', error: '资源请求较多，请稍后重试' });
      active++;
      const controller = new AbortController();
      const close = () => controller.abort();
      res.on('close', close);
      const timer = setInterval(() => {
        if (!authorize(token)) controller.abort();
      }, 500);
      try {
        const result = await handler(req, resources.resourceOwner(token), controller.signal);
        if (!authorize(token)) throw new ResourceError('UNAUTHORIZED', '配对已失效', 401);
        if (controller.signal.aborted) return;
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (
          result &&
          typeof result === 'object' &&
          'bytes' in result &&
          Buffer.isBuffer(result.bytes) &&
          'mimeType' in result
        ) {
          res.type(String(result.mimeType));
          res.send(result.bytes);
        } else res.json(result);
      } catch (cause) {
        const error = resources.resourceError(cause);
        if (!res.headersSent && !res.destroyed)
          res.status(error.status).json({ code: error.code, error: error.message });
      } finally {
        active--;
        clearInterval(timer);
        res.off('close', close);
      }
    };
  router.post(
    '/sessions/:id/resources/resolve',
    run((req, owner, signal) =>
      resources.resolveResource(
        owner,
        req.params.id,
        req.body?.reference,
        req.body?.baseResourceId,
        signal,
      ),
    ),
  );
  router.get(
    '/resources/:id',
    run((req, owner) => resources.resourceMetadata(owner, req.params.id)),
  );
  router.get(
    '/resources/:id/entries',
    run((req, owner, signal) =>
      resources.resourceList(
        owner,
        req.params.id,
        typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        signal,
      ),
    ),
  );
  for (const variant of ['text', 'thumbnail', 'content'] as const) {
    router.get(
      `/resources/:id/${variant}`,
      run((req, owner, signal) => {
        const startLine = Number(req.query.startLine || '1');
        if (
          !Number.isSafeInteger(startLine) ||
          startLine < 1 ||
          startLine > 1000000 ||
          typeof req.query.version !== 'string'
        )
          throw new ResourceError('INVALID_RANGE', '预览参数无效');
        return resources.resourceContent(
          owner,
          req.params.id,
          req.query.version,
          variant,
          startLine,
          signal,
        );
      }),
    );
  }
  return router;
}
