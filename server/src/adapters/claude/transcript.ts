/** 读取 Claude 本机记录并转换为平台视图，兼容不同版本的记录格式。 */
import type { TranscriptRecord, TranscriptBlock, SessionMetadata } from '../../types/claude.js';
import type { SessionView, ProjectView, TaskEvent } from '../../types/domain.js';
// Reads REAL Claude Code data from ~/.claude/projects/<project>/<session>.jsonl
// — the same files the CLI itself reads. This is the source of truth for the
// project list, session list, and conversation history (no CLI command exposes
// these, so we read the files directly).
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rawToolInput } from '../../domain/hook-state.js';
import { sessionOverlayEvents } from '../../repositories/overlay.repository.js';

export const PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * 同时支持 Windows 与 POSIX 路径的展示名称。
 * @param p 原始 hook 或模拟事件负载。
 * @returns 最后一个路径段，空路径返回 null。
 */
function basename(p: string | null | undefined) {
  if (!p) return null;
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * 容忍 JSONL 尾部未写完或损坏的记录，避免整页历史读取失败。
 * @param line 一行完整 JSON 协议文本。
 * @returns 解析后的记录，无法解析时为 null。
 */
function pj(line: string): TranscriptRecord | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 限制展示文本长度，保留列表可读性。
 * @param s 当前函数处理的文本或会话记录。
 * @param n 展示文本允许的最大字符数。
 * @returns 截断后的文本或原有空值。
 */
function truncate(s: string | null | undefined, n: number): string | null {
  if (typeof s !== 'string') return s == null ? null : String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * 把来源时间转换为统一毫秒时间戳。
 * @param iso 来源记录中的 ISO 时间字符串。
 * @returns 有效时间或 null。
 */
function tsMs(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ---- bounded file reads (avoid loading huge transcripts fully) ----
/**
 * 限量读取文件头并丢弃未读完整的最后一行，避免加载巨大历史。
 * @param file 待读取的文件完整路径。
 * @param maxBytes 本次最多读取的文件字节数。
 * @returns 完整 JSONL 行列表。
 */
async function readHeadLines(file: string, maxBytes = 131072) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    let text = buf.toString('utf8');
    if (len < size) {
      const nl = text.lastIndexOf('\n');
      if (nl >= 0) text = text.slice(0, nl); // drop partial last line
    }
    return text.split('\n').filter(Boolean);
  } finally {
    await fh.close();
  }
}

/**
 * 限量读取文件尾并丢弃不完整的首行，用于最近历史和摘要。
 * @param file 待读取的文件完整路径。
 * @param maxBytes 本次最多读取的文件字节数。
 * @returns 完整 JSONL 行列表。
 */
async function readTailLines(file: string, maxBytes = 131072) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1); // drop partial first line
    }
    return text.split('\n').filter(Boolean);
  } finally {
    await fh.close();
  }
}

/**
 * 只读取主会话文件，避免把子代理记录重复展示为项目会话。
 * @param dir 待读取的项目目录。
 * @returns 该目录下的主会话文件路径。
 */
async function topLevelSessionFiles(dir: string) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && SESSION_RE.test(e.name))
    .map((e) => path.join(dir, e.name));
}

// Lightweight metadata for one session file (head+tail only).
/**
 * 只读文件首尾推导轻量元数据，列表请求无需解析全部正文。
 * @param file 待读取的文件完整路径。
 * @returns 会话 ID、工作目录和最近活动摘要。
 */
async function sessionMeta(file: string): Promise<SessionMetadata> {
  const sessionId = path.basename(file, '.jsonl');
  let stat = null;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { sessionId, file };
  }
  const head = await readHeadLines(file).catch(() => []);
  const tail = await readTailLines(file).catch(() => []);
  let cwd = null;
  let startedAt = null;
  let title = null;
  let lastPrompt = null;
  let lastTs = null;
  let firstUserText = null;

  for (const l of head) {
    const o = pj(l);
    if (!o) continue;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!startedAt && o.type === 'user' && o.timestamp) startedAt = tsMs(o.timestamp);
    if (!firstUserText && o.type === 'user' && typeof o.message?.content === 'string') {
      firstUserText = o.message.content;
    }
    if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
  }
  for (const l of tail) {
    const o = pj(l);
    if (!o) continue;
    if (o.cwd && !cwd) cwd = o.cwd;
    if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
    if (o.type === 'last-prompt' && o.lastPrompt) lastPrompt = o.lastPrompt;
    if (o.timestamp) {
      const t = tsMs(o.timestamp);
      if (t && (!lastTs || t > lastTs)) lastTs = t;
    }
  }

  return {
    sessionId,
    file,
    cwd,
    title: title || lastPrompt || (firstUserText ? truncate(firstUserText, 60) : null),
    startedAt,
    lastActivityAt: lastTs || Math.round(stat.mtimeMs),
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

// ---- public API ----

// One session's lightweight summary (shared by the project list + session list).
/**
 * 把文件元信息转换为客户端沿用的会话字段。
 * @param m 从会话文件提取的轻量元数据。
 * @returns 会话摘要。
 */
function sessionSummary(m: SessionMetadata): SessionView {
  return {
    session_id: m.sessionId,
    cwd: m.cwd,
    status: fileStatus(m.lastActivityAt),
    summary: m.title,
    started_at: m.startedAt,
    updated_at: m.lastActivityAt,
  };
}

/// All projects = top-level dirs under PROJECTS_DIR that contain >=1 session file.
/**
 * 收集项目摘要，避免为列表读取完整对话正文。
 * @returns 按最近活动排序的项目列表。
 */
export async function listProjects(): Promise<ProjectView[]> {
  let entries;
  try {
    entries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, e.name);
    const files = await topLevelSessionFiles(dir);
    if (!files.length) continue;
    // latest session by mtime represents the project's current state
    const metas = await Promise.all(files.map(sessionMeta));
    metas.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    const latest = metas[0];
    const cwd = metas.find((m) => m.cwd)?.cwd || null;
    out.push({
      projectId: e.name, // stable dir name id
      name: basename(cwd) || e.name,
      cwd: cwd || '',
      status: fileStatus(latest.lastActivityAt),
      activeSessionId: latest.sessionId,
      summary: latest.title,
      progress: null,
      pendingApproval: null,
      lastEventAt: latest.lastActivityAt || 0,
      sessionCount: files.length,
      sessions: metas.map(sessionSummary), // newest-first (metas already sorted)
    });
  }
  out.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return out;
}

/// Sessions within a project (projectId = the dir name).
/**
 * 从统一项目视图展开会话，兼容旧版列表接口。
 * @param projectId 目标项目标识。
 * @returns 通过 HTTP 返回会话列表。
 */
export async function listSessions(projectId: string) {
  const dir = path.join(PROJECTS_DIR, projectId);
  const files = await topLevelSessionFiles(dir);
  const metas = await Promise.all(files.map(sessionMeta));
  metas.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return metas.map(sessionSummary);
}

/// Locate a session's jsonl across all project dirs.
/**
 * 在项目目录范围定位指定会话的 JSONL 文件。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 完整文件路径，未找到时为 null。
 */
export function findSessionFile(sessionId: string) {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(PROJECTS_DIR, e.name, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/// Full conversation for a session as TaskEvent[] (chronological-id order),
/// reusing the shape the Flutter app already consumes. Adds AssistantText
/// (real Claude prose) which hooks never had.
/**
 * 读取有大小上限的历史并加入本平台产生的审批结果。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param options 本次操作的具名参数，缺省值由实现统一处理。
 * @param options.maxLines 最多读取的记录行数，限制大型会话的内存开销。
 * @returns 统一格式的会话事件。
 */
export async function readConversation(
  sessionId: string,
  { maxLines = 5000 } = {},
): Promise<TaskEvent[]> {
  const file = findSessionFile(sessionId);
  const lines = file ? await readTailLines(file, 4 * 1024 * 1024).catch(() => []) : [];
  const slice = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  const events = parseEvents(slice, sessionId);
  // A7: append synthesized approval-result events (in-memory overlay) so the
  // app sees "已批准/已拒绝" traces that the transcript itself never records.
  for (const ev of sessionOverlayEvents(sessionId)) {
    events.push({ status: 'done', ok: null, ...ev, id: events.length, session_id: sessionId });
  }
  return events;
}

/**
 * 忽略无法展示的内容块，只保留工具结果中的文本。
 * @param content 主机返回的字符串或内容块。
 * @returns 合并后的工具输出。
 */
function toolResultText(content?: string | TranscriptBlock[]) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : (b?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Parse jsonl lines -> events. Pairs assistant tool_use with the following
// user tool_result by tool_use_id. id = sequential index (chronological).
/**
 * 关联工具调用与结果，并把 JSONL 记录转换为客户端时间线。
 * @param lines 按原始顺序排列的完整 JSONL 记录。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 按记录顺序组织的事件列表。
 */
function parseEvents(lines: string[], sessionId: string): TaskEvent[] {
  const events: TaskEvent[] = [];
  const toolUses = new Map<string | undefined, Pick<TranscriptBlock, 'name' | 'input'>>();
  let idx = 0;
  /**
   * 为解析后的事件分配页面内顺序并补齐共同字段。
   * @param e 准备保存的事件。
   * @returns 写入后事件列表的长度。
   */
  const emit = (e: TaskEvent) =>
    events.push({ id: idx++, session_id: sessionId, status: 'running', ok: null, ...e });

  for (const line of lines) {
    const o = pj(line);
    if (!o) continue;
    const ts = tsMs(o.timestamp);

    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') {
        if (c.trim())
          emit({ hook_event_name: 'UserPromptSubmit', detail: c, summary: '用户', created_at: ts });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'text' && b.text?.trim()) {
            emit({
              hook_event_name: 'UserPromptSubmit',
              detail: b.text,
              summary: '用户',
              created_at: ts,
            });
          } else if (b.type === 'tool_result') {
            const tu = toolUses.get(b.tool_use_id) || {};
            const ok = b.is_error ? false : true;
            emit({
              hook_event_name: 'PostToolUse',
              tool_name: tu.name || null,
              ok,
              detail: truncate(toolResultText(b.content), 2000),
              summary: `${tu.name || '工具'} ${ok ? '完成' : '失败'}`,
              created_at: ts,
            });
          }
        }
      }
    } else if (o.type === 'assistant' && o.message) {
      const c = o.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'text' && b.text?.trim()) {
            emit({
              hook_event_name: 'AssistantText',
              detail: b.text,
              summary: 'Claude',
              created_at: ts,
            });
          } else if (b.type === 'thinking' && b.thinking?.trim()) {
            emit({
              hook_event_name: 'Thinking',
              detail: truncate(b.thinking, 4000),
              summary: 'thinking',
              created_at: ts,
            });
          } else if (b.type === 'tool_use') {
            toolUses.set(b.id, { name: b.name, input: b.input });
            emit({
              hook_event_name: 'PreToolUse',
              tool_name: b.name,
              detail: rawToolInput(b.input),
              summary: `执行 ${b.name}`,
              created_at: ts,
            });
          }
        }
      } else if (typeof c === 'string' && c.trim()) {
        emit({ hook_event_name: 'AssistantText', detail: c, summary: 'Claude', created_at: ts });
      }
    }
  }
  return events;
}

// A session counts as "running" if its file changed within the last 90s,
// otherwise "done" (so it lands in a real F1 group — needs/running/done).
/**
 * 在没有实时信号时用文件活动时间推断运行状态。
 * @param lastActivityAt 最近主机活动的毫秒时间戳。
 * @returns running 或 done。
 */
function fileStatus(lastActivityAt?: number) {
  if (!lastActivityAt) return 'done';
  return Date.now() - lastActivityAt < 90_000 ? 'running' : 'done';
}

/// Metadata (incl. cwd) for one session, used when sending a message via the
/// CLI (which must run in that session's working directory).
/**
 * 读取会话对应的工作目录，确保续聊在正确目录启动。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 轻量元数据，文件不存在时为 null。
 */
export async function sessionInfo(sessionId: string) {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  return sessionMeta(file);
}

// Re-derive a single project object for a given project dir (used by watcher).
/**
 * 从本机索引查找单个项目，复用列表一致的派生规则。
 * @param projectId 目标项目标识。
 * @returns 项目视图，未找到时为 null。
 */
export async function getProjectByDir(projectId: string) {
  const all = await listProjects();
  return all.find((p) => p.projectId === projectId) || null;
}

// Map a session file path -> its projectId (dir name).
/**
 * 从受监控文件路径提取项目目录标识。
 * @param file 待读取的文件完整路径。
 * @returns 项目 ID，无法提取时为 null。
 */
export function projectIdForFile(file: string) {
  const rel = path.relative(PROJECTS_DIR, file);
  const seg = rel.split(/[\\/]/)[0];
  return seg || null;
}
