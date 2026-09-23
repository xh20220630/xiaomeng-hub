// SQLite persistence using Node's built-in node:sqlite (no native build needed).
// Tables: sessions (latest state per session), events (append-only timeline),
// approvals (remote-approval requests + their resolution).
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    cwd         TEXT,
    status      TEXT,
    last_event  TEXT,
    last_tool   TEXT,
    summary     TEXT,
    started_at  INTEGER,
    updated_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT,
    hook_event_name TEXT,
    tool_name       TEXT,
    status          TEXT,
    summary         TEXT,
    detail          TEXT,
    ok              INTEGER,
    raw_json        TEXT,
    created_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
  CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    session_id  TEXT,
    project_id  TEXT,
    kind        TEXT,
    title       TEXT,
    command     TEXT,
    file_path   TEXT,
    diff        TEXT,
    risk        TEXT,
    options     TEXT,
    status      TEXT,
    created_at  INTEGER,
    expires_at  INTEGER,
    resolved_at INTEGER,
    decided_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
`);

// ---------- sessions ----------
const _upsert = db.prepare(`
  INSERT INTO sessions (session_id, cwd, status, last_event, last_tool, summary, started_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    cwd        = COALESCE(excluded.cwd, sessions.cwd),
    status     = excluded.status,
    last_event = excluded.last_event,
    last_tool  = COALESCE(excluded.last_tool, sessions.last_tool),
    summary    = excluded.summary,
    updated_at = excluded.updated_at
`);

export function upsertSession(s) {
  const now = Date.now();
  _upsert.run(s.session_id, s.cwd ?? null, s.status, s.last_event, s.last_tool ?? null, s.summary, now, now);
}

const _insertEvent = db.prepare(`
  INSERT INTO events (session_id, hook_event_name, tool_name, status, summary, detail, ok, raw_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertEvent(e) {
  const now = Date.now();
  const info = _insertEvent.run(
    e.session_id,
    e.hook_event_name,
    e.tool_name ?? null,
    e.status,
    e.summary,
    e.detail ?? null,
    e.ok === null || e.ok === undefined ? null : e.ok ? 1 : 0,
    e.raw_json,
    now,
  );
  return { id: Number(info.lastInsertRowid), created_at: now };
}

const _getSessions = db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`);
export function getSessions() {
  return _getSessions.all();
}

const _getSession = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);
export function getSession(id) {
  return _getSession.get(id);
}

const _getEvents = db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?`);
export function getEvents(id, limit = 200) {
  // `ok` is stored as INTEGER (0/1); normalize to a JSON boolean (or null) so it
  // matches the WebSocket event shape the client expects.
  return _getEvents.all(id, limit).map((r) => ({
    ...r,
    ok: r.ok === null || r.ok === undefined ? null : r.ok === 1,
  }));
}

// ---------- approvals ----------
const _insertApproval = db.prepare(`
  INSERT INTO approvals
    (approval_id, session_id, project_id, kind, title, command, file_path, diff, risk, options, status, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
`);

export function insertApproval(a) {
  _insertApproval.run(
    a.approvalId,
    a.sessionId ?? null,
    a.projectId ?? null,
    a.kind,
    a.title,
    a.command ?? null,
    a.filePath ?? null,
    a.diff ?? null,
    a.risk ?? null,
    JSON.stringify(a.options ?? ['once', 'always', 'reject']),
    a.createdAt,
    a.expiresAt ?? null,
  );
}

const _resolveApproval = db.prepare(`
  UPDATE approvals SET status = ?, resolved_at = ?, decided_by = ?
  WHERE approval_id = ? AND status = 'pending'
`);
// Returns true if this call actually transitioned a pending row (idempotency guard).
export function resolveApprovalRow(approvalId, status, by) {
  const info = _resolveApproval.run(status, Date.now(), by ?? null, approvalId);
  return info.changes > 0;
}

const _getApproval = db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`);
export function getApprovalRow(id) {
  return _getApproval.get(id);
}

const _getPending = db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC`);
export function getPendingApprovals() {
  return _getPending.all();
}

const _getApprovals = db.prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`);
export function getApprovals(limit = 100) {
  return _getApprovals.all(limit);
}

// Expire pending approvals past their expires_at; returns the expired ids.
const _expire = db.prepare(
  `UPDATE approvals SET status='expired', resolved_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < ?`,
);
const _expiredIds = db.prepare(
  `SELECT approval_id FROM approvals WHERE status='expired' AND resolved_at=?`,
);
export function expireApprovals() {
  const now = Date.now();
  const info = _expire.run(now, now);
  if (info.changes === 0) return [];
  return _expiredIds.all(now).map((r) => r.approval_id);
}

// ---------- projects (derived from sessions + pending approvals) ----------
function basename(p) {
  if (!p) return null;
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

export function approvalRowToJson(r) {
  if (!r) return null;
  return {
    approvalId: r.approval_id,
    sessionId: r.session_id,
    projectId: r.project_id,
    kind: r.kind,
    title: r.title,
    command: r.command,
    filePath: r.file_path,
    diff: r.diff,
    risk: r.risk,
    options: (() => {
      try {
        return JSON.parse(r.options || '[]');
      } catch {
        return ['once', 'always', 'reject'];
      }
    })(),
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

export function projectIdForCwd(cwd, fallback) {
  return cwd && cwd.length ? cwd : fallback;
}

function toProject(session, approvalRow, key) {
  const ap = approvalRow ? approvalRowToJson(approvalRow) : null;
  return {
    projectId: key,
    name: basename(session.cwd) || (session.session_id || '').slice(0, 8),
    cwd: session.cwd || '',
    status: ap ? 'needs_approval' : session.status,
    activeSessionId: session.session_id,
    summary: session.summary,
    progress: null,
    pendingApproval: ap,
    lastEventAt: session.updated_at || 0,
  };
}

// Aggregates sessions by cwd (latest session per cwd wins) and attaches any
// pending approval for that session.
export function getProjects() {
  const sessions = getSessions();
  const pending = getPendingApprovals();
  const byCwd = new Map();
  for (const s of sessions) {
    const key = projectIdForCwd(s.cwd, s.session_id);
    const cur = byCwd.get(key);
    if (!cur || (s.updated_at || 0) > (cur.updated_at || 0)) byCwd.set(key, s);
  }
  const out = [];
  for (const [key, s] of byCwd) {
    const ap = pending.find((a) => a.session_id === s.session_id);
    out.push(toProject(s, ap, key));
  }
  out.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return out;
}

// Single project for the session's cwd (used to broadcast project.update).
export function getProjectForSession(sessionId) {
  const s = getSession(sessionId);
  if (!s) return null;
  const key = projectIdForCwd(s.cwd, s.session_id);
  const pending = getPendingApprovals().find((a) => a.session_id === sessionId);
  return toProject(s, pending, key);
}

export default db;
