// Watches ~/.claude/projects for transcript changes and pushes live updates:
// when a session's jsonl changes, broadcast a refreshed project + a
// session.changed signal (the app re-fetches that conversation).
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './claude-data.js';
import { broadcast } from './ws.js';
import { buildProjectByDir } from './snapshot.js';

const debounce = new Map();

// A session's status flips running -> done purely by time (no file activity for
// ~90s, see claude-data.fileStatus). fs.watch only fires on CHANGES, so nothing
// would ever push that transition to the app — the last change we broadcast is
// always "running". These per-project timers re-broadcast a project ~95s after
// its last activity so the app receives the "done" status (and fires the
// "✅ 任务完成" notification). Reset on every new change for that project.
const settle = new Map();
const SETTLE_MS = 95_000;

function scheduleSettle(projectId) {
  clearTimeout(settle.get(projectId));
  settle.set(
    projectId,
    setTimeout(async () => {
      settle.delete(projectId);
      try {
        const project = await buildProjectByDir(projectId);
        if (project) broadcast({ type: 'project.update', project });
      } catch (e) {
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
          } catch (e) {
            console.error('[watcher]', e.message);
          }
        }, 400),
      );
    });
    console.log('[watcher] watching', PROJECTS_DIR);
  } catch (e) {
    console.error('[watcher] failed:', e.message);
  }
  return watcher;
}
