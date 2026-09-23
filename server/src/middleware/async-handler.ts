/** Express 4 不会自动把异步拒绝交给错误中间件，因此集中适配控制器。 */
import type { Request, Response, RequestHandler } from 'express';

/**
 * 同时捕获同步异常和 Promise 拒绝。
 * @param handler 已完成路由绑定的控制器。
 * @returns 交由 Express 执行的请求处理器。
 */
export function asyncHandler(handler: (req: Request, res: Response) => unknown): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve()
      .then(() => handler(req, res))
      .catch(next);
  };
}
