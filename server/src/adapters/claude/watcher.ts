/** 监听本机记录变化并合并频繁更新，减少重复快照和磁盘读取。 */
import { asError } from '../../utils/errors.js';
// Watches ~/.claude/projects for transcript changes and pushes live updates:
// when a session's jsonl changes, broadcast a refreshed project + a
// session.changed signal (the app re-fetches that conversation).
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './transcript.js';
import { broadcast } from '../../events/hub-events.js';
import { buildProjectByDir } from '../../services/snapshot.service.js';

const debounce = new Map<string, ReturnType<typeof setTimeout>>();

// A session's status flips running -> done purely by time (no file activity for
// ~90s, see claude-data.fileStatus). fs.watch only fires on CHANGES, so nothing
// would ever push that transition to the app — the last change we broadcast is
// always "running". These per-project timers re-broadcast a project ~95s after
// its last activity so the app receives the "done" status (and fires the
// "✅ 任务完成" notification). Reset on every new change for that project.
const settle = new Map<string, ReturnType<typeof setTimeout>>();
const SETTLE_MS = 95_000;

/**
 * 在文件静默后重新推送状态，补足 fs.watch 不会报告时间流逝的限制。
 * @param projectId 目标项目标识。
 * @returns 无返回值。
 */
function scheduleSettle(projectId: string) {
  clearTimeout(settle.get(projectId));
  settle.set(
    projectId,
    setTimeout(async () => {
      settle.delete(projectId);
      try {
        const project = await buildProjectByDir(projectId);
        if (project) broadcast({ type: 'project.update', project });
      } catch (cause) {
        const e = asError(cause);
        console.error('[watcher:settle]', e.message);
      }
    }, SETTLE_MS),
  );
}

// Project dirs to ignore (comma-separated). Useful to exclude the monitor's own
// live session so it doesn't flood updates during local development/testing.
const IGNORE = (process.env.WATCH_IGNORE || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 监听主会话 JSONL，并以项目为粒度防抖推送变化。
 * @returns 文件监听器；监听不可用时为 undefined。
 */
export function startWatcher() {
  let watcher;
  try {
    watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (!rel.endsWith('.jsonl')) return;
      const parts = rel.split(/[\\/]/);
      if (parts.includes('subagents') || parts.includes('workflows')) return; // ignore subagent transcripts
      const projectId = parts[0];
      if (IGNORE.includes(projectId)) return;
      const sessionId = path.basename(parts[parts.length - 1], '.jsonl');
      const key = `${projectId}|${sessionId}`;
      clearTimeout(debounce.get(key));
      debounce.set(
        key,
        setTimeout(async () => {
          debounce.delete(key);
          try {
            const project = await buildProjectByDir(projectId);
            if (project) broadcast({ type: 'project.update', project });
            broadcast({ type: 'session.changed', sessionId, projectId });
            // Re-check ~95s from now: if the file stays quiet, this project has
            // finished and we push the running -> done transition to the app.
            scheduleSettle(projectId);
          } catch (cause) {
            const e = asError(cause);
            console.error('[watcher]', e.message);
          }
        }, 400),
      );
    });
    console.log('[watcher] watching', PROJECTS_DIR);
  } catch (cause) {
    const e = asError(cause);
    console.error('[watcher] failed:', e.message);
  }
  return watcher;
}
