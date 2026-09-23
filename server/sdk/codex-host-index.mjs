import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function readCodexHostIndex(root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const entries = await readdir(root);
  const files = entries.filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!files.length) return { projects: [], threads: [] };
  const historyFile = entries.filter((name) => /^thread_history_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  const lastTurns = new Map();
  if (historyFile) {
    const history = new DatabaseSync(path.join(root, historyFile), { readOnly: true });
    try {
      const fields = new Set(history.prepare('PRAGMA table_info(thread_turns)').all().map((r) => r.name));
      if (['thread_id', 'status', 'rollout_ordinal'].every((key) => fields.has(key))) {
        for (const row of history.prepare(`SELECT t.thread_id,t.status FROM thread_turns t
          JOIN (SELECT thread_id,MAX(rollout_ordinal) AS ordinal FROM thread_turns GROUP BY thread_id) last
          ON t.thread_id=last.thread_id AND t.rollout_ordinal=last.ordinal`).all()) lastTurns.set(row.thread_id, row.status);
      }
    } finally { history.close(); }
  }
  const db = new DatabaseSync(path.join(root, files[0]), { readOnly: true });
  try {
    // Desktop's index preserves older threads omitted by some App Server versions.
    // Only metadata is read here; conversation content stays on the public protocol.
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const projects = tables.has('projects') && tables.has('project_roots')
      ? db.prepare('SELECT p.id, p.name, r.path AS cwd FROM projects p JOIN project_roots r ON r.project_id=p.id WHERE r.position=0 ORDER BY p.position').all()
      : [];
    const fields = new Set(db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name));
    const optional = (name, fallback = 'NULL') => fields.has(name) ? name : `${fallback} AS ${name}`;
    const rows = db.prepare(`SELECT id,cwd,title,created_at,updated_at,archived,${optional('project_id')},${optional('name')},${optional('is_pinned', '0')},${optional('thread_source')},${optional('model')} FROM threads ORDER BY updated_at DESC`).all();
    return { projects, threads: rows.map((r) => ({
      id: r.id, cwd: r.cwd, name: r.name || r.title, createdAt: r.created_at, updatedAt: r.updated_at,
      archived: Boolean(r.archived), isPinned: Boolean(r.is_pinned), projectId: r.project_id,
      threadSource: r.thread_source, model: r.model, lastTurnStatus: lastTurns.get(r.id), status: { type: 'notLoaded' },
    })) };
  } finally { db.close(); }
}
