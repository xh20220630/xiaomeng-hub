/** 只读主机索引补足未加载会话，并兼容不同 Codex 版本的字段。 */
import type { HostIndex } from '../../types/codex.js';
import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 已知主机索引列，兼容缺少新字段的旧版表结构。 */
interface HostThreadRow {
  /** 当前契约中的实体或活动标识。 */
  id: string;
  /** 主机执行任务时的工作目录。 */
  cwd: string;
  /** 展示给用户的标题。 */
  title: string;
  /** 数据库记录的创建时间。 */
  created_at: number;
  /** 数据库记录的最近更新时间。 */
  updated_at: number;
  /** 主机会话是否归档。 */
  archived: number;
  /** 数据库中的项目归属键。 */
  project_id: string | null;
  /** 用于界面展示或协议寻址的名称。 */
  name: string | null;
  /** 数据库中的置顶标记。 */
  is_pinned: number;
  /** 数据库记录的会话来源。 */
  thread_source: string | null;
  /** 主机模型标识。 */
  model: string | null;
}

/**
 * 只读版本化主机数据库，补足协议列表遗漏的旧会话与保存项目。
 * @param root 主机数据或服务资源的根目录。
 * @returns 包含项目和线程摘要的主机索引。
 */
export async function readCodexHostIndex(
  root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
): Promise<HostIndex> {
  const entries = await readdir(root);
  const files = entries
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  if (!files.length) return { projects: [], threads: [] };
  const historyFile = entries
    .filter((name) => /^thread_history_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  const lastTurns = new Map<string, string>();
  if (historyFile) {
    const history = new DatabaseSync(path.join(root, historyFile), { readOnly: true });
    try {
      const fields = new Set(
        history
          .prepare('PRAGMA table_info(thread_turns)')
          .all()
          .map((r) => r.name),
      );
      if (['thread_id', 'status', 'rollout_ordinal'].every((key) => fields.has(key))) {
        for (const row of history
          .prepare(
            `SELECT t.thread_id,t.status FROM thread_turns t
          JOIN (SELECT thread_id,MAX(rollout_ordinal) AS ordinal FROM thread_turns GROUP BY thread_id) last
          ON t.thread_id=last.thread_id AND t.rollout_ordinal=last.ordinal`,
          )
          .all())
          lastTurns.set(String(row.thread_id), String(row.status));
      }
    } finally {
      history.close();
    }
  }
  const db = new DatabaseSync(path.join(root, files[0]), { readOnly: true });
  try {
    // Desktop's index preserves older threads omitted by some App Server versions.
    // Only metadata is read here; conversation content stays on the public protocol.
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    const projects =
      tables.has('projects') && tables.has('project_roots')
        ? (db
            .prepare(
              'SELECT p.id, p.name, r.path AS cwd FROM projects p JOIN project_roots r ON r.project_id=p.id WHERE r.position=0 ORDER BY p.position',
            )
            .all() as unknown as HostIndex['projects'])
        : [];
    const fields = new Set(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map((r) => r.name),
    );
    /**
     * 按当前表字段选择 SQL 投影，兼容尚未包含可选列的主机版本。
     * @param name 字段、能力或实体的展示名称。
     * @param fallback 主要来源缺失时使用的兼容值。
     * @returns 可执行的列选择表达式。
     */
    const optional = (name: string, fallback = 'NULL') =>
      fields.has(name) ? name : `${fallback} AS ${name}`;
    const rows = db
      .prepare(
        `SELECT id,cwd,title,created_at,updated_at,archived,${optional('project_id')},${optional('name')},${optional('is_pinned', '0')},${optional('thread_source')},${optional('model')} FROM threads ORDER BY updated_at DESC`,
      )
      .all() as unknown as HostThreadRow[];
    return {
      projects,
      threads: rows.map((r) => ({
        id: r.id,
        cwd: r.cwd,
        name: r.name || r.title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        archived: Boolean(r.archived),
        isPinned: Boolean(r.is_pinned),
        projectId: r.project_id,
        threadSource: r.thread_source,
        model: r.model,
        lastTurnStatus: lastTurns.get(r.id),
        status: { type: 'notLoaded' },
      })),
    };
  } finally {
    db.close();
  }
}
