import { randomUUID, createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  ResourceError,
  resourceError,
  localResources,
  MAX_IMAGE_BYTES,
} from '../resources/host-resources.js';
import type {
  ResourceContext,
  ResourceMetadata,
  ResourceRequest,
  ResourceText,
  ResourceDirectory,
} from '../types/resources.js';
import { sessionInfo } from '../adapters/claude/transcript.js';
import * as agents from './agent.service.js';
import * as repository from '../repositories/agent.repository.js';

type Source = { context: ResourceContext; agentId?: string; sourceName: string };
type Grant = Source & {
  owner: string;
  sessionId: string;
  original: ResourceMetadata;
  expires: number;
};
type Transfer = {
  agentId: string;
  signal: AbortSignal;
  receiving?: boolean;
  resolve: (value: { bytes: Buffer; mimeType: string }) => void;
  reject: (error: Error) => void;
};
const grants = new Map<string, Grant>();
const transfers = new Map<string, Transfer>();
export const resourceOwner = (token: string) => createHash('sha256').update(token).digest('hex');

async function source(sessionId: string): Promise<Source> {
  const remote = agents.remoteSession(sessionId);
  if (remote) {
    const session = JSON.parse(remote.data);
    const agent = agents.listAgents().find((item) => item.agentId === remote.agent_id);
    if (!agent?.online) throw new ResourceError('HOST_OFFLINE', '文件所属主机已离线', 409);
    if (!['resources.resolve', 'resources.read'].every((cap) => agent.capabilities.includes(cap)))
      throw new ResourceError('UNSUPPORTED_HOST', '此主机版本暂不支持资源预览，请更新后端', 409);
    return {
      context: { sessionId: remote.remote_id, cwd: session.cwd || '' },
      agentId: remote.agent_id,
      sourceName: agent.nodeName,
    };
  }
  if (process.env.LOCAL_CLAUDE === '0' || !/^[0-9a-f-]{36}$/i.test(sessionId))
    throw new ResourceError('NOT_FOUND', '会话不存在', 404);
  const session = await sessionInfo(sessionId);
  if (!session?.cwd) throw new ResourceError('NO_WORKSPACE', '此会话没有可用的工作目录', 404);
  return { context: { sessionId, cwd: session.cwd }, sourceName: '宿主机' };
}

function metadata(value: unknown): ResourceMetadata {
  const m = value as ResourceMetadata;
  if (
    !m ||
    typeof m.resourceId !== 'string' ||
    !/^[\w-]{1,128}$/.test(m.resourceId) ||
    typeof m.name !== 'string' ||
    m.name.length > 1024 ||
    !/^[a-f0-9]{64}$/.test(m.version) ||
    !['image', 'text', 'markdown', 'directory', 'file'].includes(m.kind) ||
    !Number.isSafeInteger(m.size) ||
    m.size < 0 ||
    typeof m.mimeType !== 'string'
  ) {
    throw new ResourceError('INVALID_RESPONSE', '主机返回了无效的文件信息', 502);
  }
  return m;
}

async function command(
  source: Source,
  sessionId: string,
  type: string,
  resource: ResourceRequest,
  signal: AbortSignal,
) {
  const queued = agents.queueCommand(
    source.agentId!,
    type,
    { sessionId: source.context.sessionId, resource },
    { sessionId },
  );
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ResourceError('CANCELLED', '读取已取消', 499);
    const state = agents.commandInfo(queued.commandId);
    if (['succeeded', 'failed', 'expired'].includes(state.status)) {
      repository.updateCommandResult(
        JSON.stringify({ ok: state.result?.ok === true, result: null }),
        queued.commandId,
      );
      if (state.status !== 'succeeded') {
        const message = state.result?.error || '主机读取失败';
        const match = /^\[([A-Z_]+)\] (.*)$/.exec(message);
        throw new ResourceError(match?.[1] || 'READ_FAILED', match?.[2] || message, 409);
      }
      return state.result?.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new ResourceError('HOST_TIMEOUT', '宿主机读取超时，请重试', 504);
}

function grant(owner: string, id: string) {
  const g = grants.get(id);
  if (!g || g.owner !== owner) throw new ResourceError('NOT_FOUND', '文件预览不存在', 404);
  if (g.expires < Date.now()) {
    grants.delete(id);
    throw new ResourceError('RESOURCE_EXPIRED', '预览已过期，请重新打开', 410);
  }
  return g;
}

export async function resolveResource(
  owner: string,
  sessionId: string,
  reference: string,
  baseId: string | undefined,
  signal: AbortSignal,
) {
  if (typeof reference !== 'string' || reference.length > 4096)
    throw new ResourceError('INVALID_REFERENCE', '文件路径无效');
  const s = await source(sessionId);
  const base = baseId ? grant(owner, baseId) : undefined;
  if (base && (base.sessionId !== sessionId || base.agentId !== s.agentId))
    throw new ResourceError('OUTSIDE_ROOT', '文件不属于当前会话', 403);
  const original = metadata(
    s.agentId
      ? await command(
          s,
          sessionId,
          'resources.resolve',
          { reference, baseResourceId: base?.original.resourceId },
          signal,
        )
      : await localResources.resolve(s.context, reference, base?.original.resourceId),
  );
  if (signal.aborted) throw new ResourceError('CANCELLED', '读取已取消', 499);
  for (const [id, g] of grants) if (g.expires < Date.now()) grants.delete(id);
  const owned = [...grants].filter(([, g]) => g.owner === owner);
  for (const [id] of owned.slice(0, Math.max(0, owned.length - 127))) grants.delete(id);
  while (grants.size >= 1000) grants.delete(grants.keys().next().value!);
  const id = randomUUID();
  grants.set(id, { ...s, owner, sessionId, original, expires: Date.now() + 3600000 });
  return { ...original, resourceId: id, sourceName: s.sourceName };
}

async function ownedSource(owner: string, id: string) {
  const g = grant(owner, id);
  const s = await source(g.sessionId);
  if (s.agentId !== g.agentId || s.context.cwd !== g.context.cwd)
    throw new ResourceError('RESOURCE_CHANGED', '会话目录发生变化，请重新打开文件', 409);
  return g;
}

export async function resourceMetadata(owner: string, id: string) {
  const g = await ownedSource(owner, id);
  return { ...g.original, resourceId: id, sourceName: g.sourceName };
}

async function remoteBytes(g: Grant, request: ResourceRequest, signal: AbortSignal) {
  if (transfers.size >= 4) throw new ResourceError('BUSY', '资源请求较多，请稍后重试', 429);
  const id = randomUUID();
  let receive!: (value: { bytes: Buffer; mimeType: string }) => void;
  let reject!: (error: Error) => void;
  const upload = new Promise<{ bytes: Buffer; mimeType: string }>((yes, no) => {
    receive = yes;
    reject = no;
  });
  transfers.set(id, { agentId: g.agentId!, signal, resolve: receive, reject });
  const aborted = () => reject(new ResourceError('CANCELLED', '读取已取消', 499));
  signal.addEventListener('abort', aborted, { once: true });
  const timer = setTimeout(
    () => reject(new ResourceError('HOST_TIMEOUT', '文件传输超时', 504)),
    26000,
  );
  try {
    const [content] = await Promise.all([
      upload,
      command(g, g.sessionId, 'resources.read', { ...request, transferId: id }, signal),
    ]);
    return content;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', aborted);
    transfers.delete(id);
  }
}

export function acceptResourceTransfer(req: Request, res: Response, next: () => void) {
  const slot = transfers.get(req.params.id);
  if (!slot || slot.agentId !== req.agentId || slot.signal.aborted || slot.receiving)
    return res.status(410).json({ error: 'Resource transfer expired' });
  slot.receiving = true;
  next();
}

export function receiveResource(req: Request, res: Response) {
  const slot = transfers.get(req.params.id);
  if (!slot || slot.agentId !== req.agentId || slot.signal.aborted)
    return res.status(410).json({ error: 'Resource transfer expired' });
  const mimeType = String(req.headers['x-resource-type'] || '');
  if (
    !Buffer.isBuffer(req.body) ||
    req.body.length > MAX_IMAGE_BYTES ||
    !['image/png', 'image/jpeg', 'image/webp', 'application/json'].includes(mimeType)
  ) {
    slot.reject(new ResourceError('INVALID_RESPONSE', '资源传输格式无效', 502));
    transfers.delete(req.params.id);
    return res.status(400).json({ error: 'Invalid resource transfer' });
  }
  transfers.delete(req.params.id);
  slot.resolve({ bytes: req.body, mimeType });
  return res.json({ ok: true });
}

export async function resourceContent(
  owner: string,
  id: string,
  version: string,
  variant: 'content' | 'thumbnail' | 'text',
  startLine: number,
  signal: AbortSignal,
) {
  const g = await ownedSource(owner, id);
  if (version !== g.original.version)
    throw new ResourceError('RESOURCE_CHANGED', '文件版本不匹配，请刷新', 409);
  if (
    (variant === 'text' && !['text', 'markdown'].includes(g.original.kind)) ||
    (variant !== 'text' && g.original.kind !== 'image')
  )
    throw new ResourceError('UNSUPPORTED_TYPE', '暂不支持此文件的预览');
  if (g.agentId) {
    const result = await remoteBytes(
      g,
      { resourceId: g.original.resourceId, version, variant, startLine },
      signal,
    );
    if (variant === 'text') {
      if (result.mimeType !== 'application/json' || result.bytes.length > 1024 * 1024)
        throw new ResourceError('INVALID_RESPONSE', '文本预览数据无效', 502);
      const text = JSON.parse(result.bytes.toString('utf8')) as ResourceText;
      if (typeof text.text !== 'string' || text.version !== version || text.startLine !== startLine)
        throw new ResourceError('INVALID_RESPONSE', '文本预览数据无效', 502);
      return text;
    }
    if (!result.mimeType.startsWith('image/'))
      throw new ResourceError('INVALID_RESPONSE', '图片预览数据无效', 502);
    return result;
  }
  return variant === 'text'
    ? localResources.text(g.context, g.original.resourceId, version, startLine)
    : localResources.image(g.context, g.original.resourceId, version, variant === 'thumbnail');
}

export async function resourceList(
  owner: string,
  id: string,
  cursor: string | undefined,
  signal: AbortSignal,
) {
  const g = await ownedSource(owner, id);
  if (g.original.kind !== 'directory') throw new ResourceError('UNSUPPORTED_TYPE', '请选择目录');
  const data = g.agentId
    ? ((await command(
        g,
        g.sessionId,
        'resources.list',
        { resourceId: g.original.resourceId, cursor },
        signal,
      )) as ResourceDirectory)
    : await localResources.list(g.context, g.original.resourceId, cursor);
  if (
    !Array.isArray(data.entries) ||
    data.entries.length > 100 ||
    data.entries.some(
      (e) =>
        typeof e.name !== 'string' || typeof e.reference !== 'string' || e.reference.length > 4096,
    )
  )
    throw new ResourceError('INVALID_RESPONSE', '目录信息无效', 502);
  return { ...data, directory: { ...g.original, resourceId: id, sourceName: g.sourceName } };
}

export { resourceError };
