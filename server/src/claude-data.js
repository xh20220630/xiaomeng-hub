// Reads REAL Claude Code data from ~/.claude/projects/<project>/<session>.jsonl
// — the same files the CLI itself reads. This is the source of truth for the
// project list, session list, and conversation history (no CLI command exposes
// these, so we read the files directly).
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rawToolInput } from './state.js';
import { sessionOverlayEvents } from './overlay.js';

export const PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function basename(p) {
  if (!p) return null;
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function pj(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return s == null ? null : String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function tsMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ---- bounded file reads (avoid loading huge transcripts fully) ----
async function readHeadLines(file, maxBytes = 131072) {
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

async function readTailLines(file, maxBytes = 131072) {
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

async function topLevelSessionFiles(dir) {
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
async function sessionMeta(file) {
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
function sessionSummary(m) {
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
export async function listProjects() {
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
export async function listSessions(projectId) {
  const dir = path.join(PROJECTS_DIR, projectId);
  const files = await topLevelSessionFiles(dir);
  const metas = await Promise.all(files.map(sessionMeta));
  metas.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return metas.map(sessionSummary);
}

/// Locate a session's jsonl across all project dirs.
export function findSessionFile(sessionId) {
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
export async function readConversation(sessionId, { maxLines = 5000 } = {}) {
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

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function outputSummary(toolName, ok, text) {
  const head = (text || '').trim().split('\n')[0];
  if (EDIT_TOOLS.includes(toolName)) return ok ? '✓ 已应用' : '✗ 失败';
  if (ok === false) return `✗ ${truncate(head, 60) || '失败'}`;
  return head ? `✓ ${truncate(head, 60)}` : '✓ 完成';
}

// Parse jsonl lines -> events. Pairs assistant tool_use with the following
// user tool_result by tool_use_id. id = sequential index (chronological).
function parseEvents(lines, sessionId) {
  const events = [];
  const toolUses = new Map();
  let idx = 0;
  const emit = (e) =>
    events.push({ id: idx++, session_id: sessionId, status: 'running', ok: null, ...e });

  for (const line of lines) {
    const o = pj(line);
    if (!o) continue;
    const ts = tsMs(o.timestamp);

    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') {
        if (c.trim()) emit({ hook_event_name: 'UserPromptSubmit', detail: c, summary: '用户', created_at: ts });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'text' && b.text?.trim()) {
            emit({ hook_event_name: 'UserPromptSubmit', detail: b.text, summary: '用户', created_at: ts });
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
            emit({ hook_event_name: 'AssistantText', detail: b.text, summary: 'Claude', created_at: ts });
          } else if (b.type === 'thinking' && b.thinking?.trim()) {
            emit({ hook_event_name: 'Thinking', detail: truncate(b.thinking, 4000), summary: 'thinking', created_at: ts });
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
function fileStatus(lastActivityAt) {
  if (!lastActivityAt) return 'done';
  return Date.now() - lastActivityAt < 90_000 ? 'running' : 'done';
}

/// Metadata (incl. cwd) for one session, used when sending a message via the
/// CLI (which must run in that session's working directory).
export async function sessionInfo(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  return sessionMeta(file);
}

// Re-derive a single project object for a given project dir (used by watcher).
export async function getProjectByDir(projectId) {
  const all = await listProjects();
  return all.find((p) => p.projectId === projectId) || null;
}

// Map a session file path -> its projectId (dir name).
export function projectIdForFile(file) {
  const rel = path.relative(PROJECTS_DIR, file);
  const seg = rel.split(/[\\/]/)[0];
  return seg || null;
}
