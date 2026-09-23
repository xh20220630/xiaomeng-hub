/** WebSocket 传输层负责连接认证、初始快照和实时事件投递。 */
import { hubEvents } from '../events/hub-events.js';
import type { Server } from 'node:http';
import type WebSocket from 'ws';
import type { ClientMessage } from '../controllers/websocket.controller.js';
import type { AgentView, ProjectView, ApprovalView, SessionView } from '../types/domain.js';
import { asError } from '../utils/errors.js';
import { WebSocketServer } from 'ws';

/** 初次连接需要的完整客户端视图。 */
interface Snapshot {
  /** 在线 Agent。 */
  agents?: AgentView[];
  /** 项目及会话摘要。 */
  projects: ProjectView[];
  /** 待处理审批。 */
  approvals?: ApprovalView[];
  /** 兼容旧版客户端的会话列表。 */
  sessions?: SessionView[];
}
/** WebSocket 认证依赖。 */
interface WebSocketOptions {
  /** 默认认证令牌。 */
  authToken?: string;
  /** 配对设备与管理员共用的认证判断。 */
  authorizeToken?: (token: string) => boolean;
}

// WebSocket fan-out + upstream intake.
// On connect the client gets a legacy `snapshot` (sessions) and a v2
// `projects.snapshot`. Client frames (approval.respond / message.send /
// session.control) are dispatched to the injected `onClientMessage` handler
// (wired in index.js) — kept dependency-free to avoid an import cycle.
//
// The handshake checks ?token=<t> before upgrade; revocation also closes live sockets.
// Observability (audit A13): connect/disconnect are logged with the remote IP
// and the resulting client count.

let wss: WebSocketServer | null = null;
const accessTokens = new WeakMap<WebSocket, string>();

/**
 * 在同一个 HTTP 服务上安装认证与初始快照推送。
 * @param server 共享 REST 与 WebSocket 的 HTTP 服务。
 * @param getSnapshot 按需生成客户端初始视图的函数。
 * @param onClientMessage 处理上行操作帧的回调。
 * @param options 本次操作的具名参数，缺省值由实现统一处理。
 * @param options.authToken 管理员访问令牌，用于隔离设备绑定和验证客户端。
 * @param options.authorizeToken 同时支持管理员与设备凭据的授权判断。
 * @returns 已配置的 WebSocket 服务。
 */
export function initWs(
  server: Server,
  getSnapshot: () => Promise<Snapshot>,
  onClientMessage: (message: ClientMessage, socket: WebSocket) => unknown,
  {
    authToken = '',
    authorizeToken = (token: string) => !authToken || token === authToken,
  }: WebSocketOptions = {},
) {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024 * 1024,
    /**
     * 在 WebSocket 升级前验证访问令牌，避免未授权连接接收快照。
     * @param info 包含升级请求的 WebSocket 握手信息。
     * @returns 是否允许升级为 WebSocket。
     */
    verifyClient: (info: {
      /** 待处理的 HTTP 请求。 */
      req: import('node:http').IncomingMessage;
    }) => {
      try {
        const u = new URL(info.req.url || '', 'http://localhost');
        return authorizeToken(u.searchParams.get('token') || '');
      } catch {
        return false;
      }
    },
  });
  wss.on('connection', async (socket, req) => {
    accessTokens.set(
      socket,
      new URL(req.url || '', 'http://localhost').searchParams.get('token') || '',
    );
    // Accept controls while the initial snapshot is still being read.
    socket.on('message', (raw) => {
      if (!authorizeToken(accessTokens.get(socket) || ''))
        return socket.close(1008, 'Device access revoked');
      if (!onClientMessage) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        Promise.resolve(onClientMessage(msg, socket)).catch((e) =>
          console.error('[ws] client message error:', e.message),
        );
      } catch (cause) {
        const e = asError(cause);
        console.error('[ws] client message error:', e.message);
      }
    });
    socket.on('error', (error) => console.error('[ws]', error.message));
    const ip = req?.socket?.remoteAddress || '?';
    const ua = (req?.headers?.['user-agent'] || '?').slice(0, 40);
    console.log(`[ws] connect ${ip} (clients=${wss!.clients.size}) ua="${ua}"`);
    socket.on('close', (code, reason) =>
      console.log(
        `[ws] disconnect ${ip} (clients=${wss!.clients.size}) code=${code} reason="${String(reason || '').slice(0, 40)}" ua="${ua}"`,
      ),
    );
    try {
      const snap = await getSnapshot();
      socket.send(
        JSON.stringify({ type: 'agents.snapshot', agents: snap.agents || [], ts: Date.now() }),
      );
      socket.send(
        JSON.stringify({
          type: 'approvals.snapshot',
          approvals: snap.approvals || [],
          ts: Date.now(),
        }),
      );
      socket.send(
        JSON.stringify({ type: 'projects.snapshot', projects: snap.projects, ts: Date.now() }),
      );
      socket.send(
        JSON.stringify({ type: 'snapshot', sessions: snap.sessions || [], ts: Date.now() }),
      );
    } catch {
      /* socket may have closed immediately */
    }
  });
  return wss;
}

/**
 * 向当前在线客户端推送序列化事件，未连接客户端不缓存流式片段。
 * @param obj 准备序列化或写入的结构化数据。
 * @returns 无返回值。
 */
export function broadcast(obj: Record<string, unknown>) {
  if (!wss) return;
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  }
}

/**
 * 读取当前在线连接数用于观测。
 * @returns 连接数量。
 */
export function clientCount() {
  return wss ? wss!.clients.size : 0;
}

/**
 * 重新验证已有连接，使设备撤销立即生效。
 * @param authorizeToken 同时支持管理员与设备凭据的授权判断。
 * @returns 无返回值。
 */
export function disconnectUnauthorizedClients(authorizeToken: (token: string) => boolean) {
  for (const client of wss?.clients || []) {
    if (!authorizeToken(accessTokens.get(client) || ''))
      client.close(1008, 'Device access revoked');
  }
}

// 监听器只注册一次，重新初始化连接池时仍使用当前 WebSocket 服务。
hubEvents.on('broadcast', broadcast);
